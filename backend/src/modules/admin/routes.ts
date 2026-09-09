/**
 * Internal admin console API.
 *
 * Gated by a single shared password from ADMIN_PASSWORD, exchanged for a
 * short-lived signed token. This is deliberately not a user account: it guards
 * a small operations surface, and rotating it is an env change plus a restart.
 *
 * The token is a bearer token held by the console, not a cookie, for the same
 * reason as the session tokens — the console is served from a different domain
 * than this API, and a cross-site cookie is not reliably sent. It carries
 * `audience: 'admin'`, so a normal user's access token cannot be presented here
 * even though both arrive in the same header.
 *
 * It is still a privileged surface, so: the password is compared in constant
 * time, attempts are rate limited, the token is short-lived, and every persona
 * change is written to the audit log with the before/after value.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../lib/config.js';
import { normalizeEmail, resolvePersona } from '../../lib/persona.js';
import { generateRecommendations } from '../recommend/pipeline.js';
import { getEntitlement } from '../entitlement/allowance.js';
import { pushAssignment } from '../cosmic/assign.js';
import { drainAssignmentQueue } from '../cosmic/retry-job.js';


/** After this many runs, regenerating is repeating rather than improving. */
const MAX_RUNS_PER_PROJECT = 5;

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) {
    void reply.code(401).send({ error: 'admin login required' });
    return false;
  }
  try {
    jwt.verify(token, config.JWT_ACCESS_SECRET, { audience: 'admin' });
    return true;
  } catch {
    void reply.code(401).send({ error: 'admin session expired' });
    return false;
  }
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/admin/login',
    { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const parsed = z.object({ password: z.string() }).safeParse(request.body);
      if (!parsed.success || !safeEqual(parsed.data.password, config.ADMIN_PASSWORD)) {
        return reply.code(401).send({ error: 'incorrect password' });
      }

      const token = jwt.sign({ scope: 'admin' }, config.JWT_ACCESS_SECRET, {
        audience: 'admin',
        expiresIn: config.ADMIN_SESSION_TTL,
      } as jwt.SignOptions);

      return reply.send({ ok: true, token });
    },
  );

  /** Nothing to end server-side — the console drops the token it holds. */
  app.post('/admin/logout', async (_request, reply) => {
    return reply.send({ ok: true });
  });

  app.get('/admin/session', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    return reply.send({ ok: true });
  });

  /** Account list with search + pagination, for the persona toggle screen. */
  app.get('/admin/users', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const query = z
      .object({
        q: z.string().trim().optional(),
        persona: z.enum(['TOF', 'ENROLLED']).optional(),
        take: z.coerce.number().min(1).max(100).default(50),
        skip: z.coerce.number().min(0).default(0),
      })
      .parse(request.query);

    const where = {
      ...(query.persona ? { persona: query.persona } : {}),
      ...(query.q
        ? { email: { contains: query.q, mode: 'insensitive' as const } }
        : {}),
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
        select: {
          id: true,
          email: true,
          emailNormalized: true,
          role: true,
          persona: true,
          personaLockedAt: true,
          createdAt: true,
          student: {
            select: {
              id: true,
              name: true,
              grade: true,
              country: true,
              cosmicStudentId: true,
            },
          },
        },
      }),
      prisma.user.count({ where }),
    ]);

    // Show what the roster *would* say, so an admin can see when a manual
    // override is fighting the sheet rather than agreeing with it.
    const withRoster = await Promise.all(
      users.map(async (u) => {
        const resolution = await resolvePersona(prisma, u.email);
        // Only an enrolled student has an entitlement to show; a TOF account
        // selects nothing, so the column would be noise.
        const entitlement =
          u.persona === 'ENROLLED' && u.student
            ? await getEntitlement(prisma, u.student.id)
            : null;
        return {
          ...u,
          rosterPersona: resolution.persona,
          rosterReason: resolution.reason,
          overridden: u.personaLockedAt !== null && u.persona !== resolution.persona,
          entitlement,
        };
      }),
    );

    return reply.send({ users: withRoster, total });
  });

  /**
   * Flip an account between TOF and ENROLLED.
   *
   * A manual change sets personaLockedAt, which makes the 5-hourly roster sync
   * leave the account alone. Without that lock the next sync would silently
   * revert the admin's decision, which is the behaviour that makes manual
   * overrides untrustworthy.
   */
  app.patch('/admin/users/:id/persona', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        persona: z.enum(['TOF', 'ENROLLED']),
        /** Clear the lock so the roster resumes control of this account. */
        followRoster: z.boolean().optional(),
        note: z.string().max(500).optional(),
      })
      .safeParse(request.body);

    if (!body.success) return reply.code(400).send({ error: 'persona must be TOF or ENROLLED' });

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: 'user not found' });

    const updated = await prisma.user.update({
      where: { id },
      data: {
        persona: body.data.persona,
        personaLockedAt: body.data.followRoster ? null : new Date(),
        // Force a token refresh so the change takes effect on the next request
        // instead of when the current access token happens to expire.
        tokenVersion: { increment: 1 },
      },
      select: { id: true, email: true, persona: true, personaLockedAt: true },
    });

    await prisma.auditLog.create({
      data: {
        action: 'PERSONA_CHANGED_BY_ADMIN',
        entity: 'User',
        entityId: id,
        before: { persona: user.persona, personaLockedAt: user.personaLockedAt },
        after: {
          persona: updated.persona,
          personaLockedAt: updated.personaLockedAt,
          ...(body.data.note ? { note: body.data.note } : {}),
        },
      },
    });

    return reply.send({ user: updated });
  });

  /** Roster and ingest health, so the admin can tell why someone got which flow. */
  app.get('/admin/overview', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const [
      tof,
      enrolled,
      overridden,
      roster,
      rosterNoProject,
      competitions,
      byRegion,
      lastSync,
      picks,
      pendingReviews,
      pendingVerifications,
      neverVerified,
    ] =
      await Promise.all([
        prisma.user.count({ where: { persona: 'TOF' } }),
        prisma.user.count({ where: { persona: 'ENROLLED' } }),
        prisma.user.count({ where: { personaLockedAt: { not: null } } }),
        prisma.enrolledRosterEntry.count({ where: { active: true } }),
        // The gap that silently stops the Day 9 email from ever firing.
        prisma.enrolledRosterEntry.count({
          where: { active: true, projectName: null, projectDescription: null },
        }),
        prisma.competition.count(),
        prisma.competition.groupBy({ by: ['region'], _count: true }),
        prisma.sheetSyncRun.findFirst({ orderBy: { startedAt: 'desc' } }),
        prisma.enrolledTopPicks.count({ where: { competition3: { not: null } } }),
        prisma.recommendationRun.count({ where: { status: 'PENDING_REVIEW' } }),
        // Proposals from the verification sweep. Nothing is applied to a
        // competition until a human approves one, so a queue nobody watches is
        // a repository that quietly stops being checked.
        prisma.verificationEvent.count({ where: { status: 'PENDING_REVIEW' } }),
        prisma.competition.count({ where: { lastVerifiedAt: null } }),
      ]);

    return reply.send({
      users: { tof, enrolled, overridden },
      rosterEntries: roster,
      rosterWithoutProject: rosterNoProject,
      studentsWithPicks: picks,
      pendingReviews,
      pendingVerifications,
      neverVerified,
      competitions: {
        total: competitions,
        byRegion: Object.fromEntries(byRegion.map((r) => [r.region, r._count])),
      },
      lastRosterSync: lastSync,
      warning:
        roster === 0 ? 'roster is empty — every signup currently resolves to TOF' : undefined,
    });
  });

  /**
   * The review queue — the destination of the "View competition details" link
   * in the internal notification email.
   */
  app.get('/admin/reviews', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const runs = await prisma.recommendationRun.findMany({
      where: { status: 'PENDING_REVIEW' },
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: {
        project: {
          select: {
            name: true,
            description: true,
            student: { select: { name: true, grade: true, school: true, country: true } },
          },
        },
        _count: { select: { items: true } },
      },
    });

    return reply.send({
      reviews: runs.map((run) => ({
        id: run.id,
        createdAt: run.createdAt,
        itemCount: run._count.items,
        studentName: run.project.student?.name ?? null,
        grade: run.project.student?.grade ?? null,
        school: run.project.student?.school ?? null,
        projectName: run.project.name,
      })),
    });
  });

  /** One run in full, including why each competition was chosen. */
  app.get('/admin/reviews/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const run = await prisma.recommendationRun.findUnique({
      where: { id },
      include: {
        project: {
          select: {
            name: true,
            description: true,
            domain: true,
            student: { select: { name: true, grade: true, school: true, country: true } },
          },
        },
      },
    });
    if (!run) return reply.code(404).send({ error: 'not found' });

    return reply.send({
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
      project: run.project,
      payload: run.payload,
      // Internal surface: the reviewer should see what was dropped and why,
      // which is exactly what the student flow must never expose.
      retrievalTrace: run.retrievalTrace,
    });
  });

  /**
   * Approve — this is what makes a recommendation set client-facing. Until it
   * happens the student sees "your matches are with the CreatED team".
   */
  app.post('/admin/reviews/:id/approve', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ note: z.string().max(1000).optional() }).safeParse(request.body ?? {});

    const run = await prisma.recommendationRun.findUnique({ where: { id } });
    if (!run) return reply.code(404).send({ error: 'not found' });
    if (run.status !== 'PENDING_REVIEW') {
      return reply.code(409).send({ error: `run is ${run.status}, not awaiting review` });
    }

    const updated = await prisma.recommendationRun.update({
      where: { id },
      data: {
        status: 'APPROVED',
        reviewedAt: new Date(),
        ...(body.success && body.data.note ? { reviewNotes: body.data.note } : {}),
      },
      select: { id: true, status: true, reviewedAt: true },
    });

    await prisma.auditLog.create({
      data: {
        action: 'RECOMMENDATIONS_APPROVED',
        entity: 'RecommendationRun',
        entityId: id,
        before: { status: run.status },
        after: { status: 'APPROVED' },
      },
    });

    return reply.send({ run: updated });
  });

  /**
   * Reject, then regenerate.
   *
   * The rejection note is fed to the ranker as a correction — regenerating
   * without it would produce the same list and earn the same rejection. The
   * classification is recomputed too, since "these are wrong" often means the
   * project was read wrongly in the first place.
   */
  app.post('/admin/reviews/:id/reject', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        note: z.string().max(1000).optional(),
        /** Escape hatch: reject without producing a replacement. */
        regenerate: z.boolean().default(true),
      })
      .parse(request.body ?? {});

    const run = await prisma.recommendationRun.findUnique({
      where: { id },
      include: { project: { include: { student: true } } },
    });
    if (!run) return reply.code(404).send({ error: 'not found' });

    const updated = await prisma.recommendationRun.update({
      where: { id },
      data: {
        status: 'REJECTED',
        reviewedAt: new Date(),
        ...(body.note ? { reviewNotes: body.note } : {}),
      },
      select: { id: true, status: true },
    });

    await prisma.auditLog.create({
      data: {
        action: 'RECOMMENDATIONS_REJECTED',
        entity: 'RecommendationRun',
        entityId: id,
        before: { status: run.status },
        after: { status: 'REJECTED', note: body.note },
      },
    });

    // Guard against a rejection loop burning model budget: each regeneration
    // costs two calls, and a project that has been through this many rounds
    // needs a person to change something, not another roll of the dice.
    const attempts = await prisma.recommendationRun.count({
      where: { projectId: run.projectId },
    });

    if (!body.regenerate) {
      return reply.send({ run: updated, regenerating: false, reason: 'not requested' });
    }
    if (attempts >= MAX_RUNS_PER_PROJECT) {
      return reply.send({
        run: updated,
        regenerating: false,
        reason: `this project has had ${attempts} runs — edit the project or the prompt rather than regenerating again`,
      });
    }

    // Fire and forget: generation is two model calls and ~30s, far too slow to
    // hold the reviewer's request open. The new run lands in the queue and
    // notifies the reviewers on its own.
    void generateRecommendations(prisma, {
      projectId: run.projectId,
      persona: 'ENROLLED',
      student: {
        grade: run.project.student?.grade ?? null,
        age: run.project.student?.age ?? null,
        country: run.project.student?.country ?? null,
      },
      reclassify: true,
      ...(body.note ? { reviewerGuidance: body.note } : {}),
    }).catch((err: unknown) => {
      request.log.error({ err, projectId: run.projectId }, 'regeneration after reject failed');
    });

    return reply.send({
      run: updated,
      regenerating: true,
      note: 'A replacement set is being generated; you will be emailed when it is ready.',
    });
  });

  // ------------------------------------------------------------------ students

  /**
   * Set how many competitions a student may activate.
   *
   * Deliberately a human decision rather than a parsed sheet column: the
   * package column is not reliably filled, and a wrong allowance either blocks a
   * paying family or gives away work. Until it is set, the configured default
   * applies.
   */
  app.put('/admin/students/:id/allowance', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const parsed = z
      .object({
        allowance: z.coerce.number().int().min(0).max(20),
        programName: z.string().max(120).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'allowance must be 0-20' });

    const student = await prisma.student.findUnique({ where: { id }, select: { id: true } });
    if (!student) return reply.code(404).send({ error: 'student not found' });

    const before = await getEntitlement(prisma, id);
    const existing = await prisma.programEnrolment.findFirst({
      where: { studentId: id },
      orderBy: { id: 'asc' },
      select: { id: true },
    });

    const enrolment = existing
      ? await prisma.programEnrolment.update({
          where: { id: existing.id },
          data: {
            competitionAllowance: parsed.data.allowance,
            ...(parsed.data.programName ? { programName: parsed.data.programName } : {}),
          },
        })
      : await prisma.programEnrolment.create({
          data: {
            studentId: id,
            programName: parsed.data.programName ?? 'CreatED program',
            competitionAllowance: parsed.data.allowance,
          },
        });

    await prisma.auditLog.create({
      data: {
        action: 'ALLOWANCE_SET',
        entity: 'Student',
        entityId: id,
        before: { allowance: before.allowance, wasDefault: before.isDefault },
        after: { allowance: parsed.data.allowance },
      },
    });

    return reply.send({ enrolment, entitlement: await getEntitlement(prisma, id) });
  });

  /**
   * Map a student onto their COSMIC record by hand.
   *
   * The automatic match is by email, and it misses whenever a parent signed up
   * here or the family is on a different address in COSMIC. Setting the id once
   * unblocks every assignment queued for that kid.
   */
  app.put('/admin/students/:id/cosmic-id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const parsed = z
      .object({ cosmicStudentId: z.string().max(64).nullable() })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'cosmicStudentId is required' });

    const student = await prisma.student.findUnique({
      where: { id },
      select: { cosmicStudentId: true },
    });
    if (!student) return reply.code(404).send({ error: 'student not found' });

    const updated = await prisma.student.update({
      where: { id },
      data: { cosmicStudentId: parsed.data.cosmicStudentId },
      select: { id: true, name: true, cosmicStudentId: true },
    });

    await prisma.auditLog.create({
      data: {
        action: 'COSMIC_ID_SET',
        entity: 'Student',
        entityId: id,
        before: { cosmicStudentId: student.cosmicStudentId },
        after: { cosmicStudentId: parsed.data.cosmicStudentId },
      },
    });

    return reply.send({ student: updated });
  });

  // --------------------------------------------------------------- assignments

  /** The COSMIC assignment queue: what is waiting, on what, and since when. */
  app.get('/admin/assignments', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const query = z
      .object({
        status: z
          .enum(['READY', 'WAITING_FOR_STUDENT', 'WAITING_FOR_PROJECT', 'SENT', 'FAILED'])
          .optional(),
        take: z.coerce.number().min(1).max(200).default(50),
      })
      .parse(request.query);

    const assignments = await prisma.competitionAssignment.findMany({
      where: query.status ? { status: query.status } : {},
      orderBy: { createdAt: 'desc' },
      take: query.take,
      include: {
        competition: { select: { name: true, slug: true } },
        student: {
          select: {
            id: true,
            name: true,
            cosmicStudentId: true,
            user: { select: { email: true } },
          },
        },
      },
    });

    const counts = await prisma.competitionAssignment.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    return reply.send({
      assignments,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    });
  });

  /** Retry one assignment now — after mapping a COSMIC id, or creating a project there. */
  app.post('/admin/assignments/:id/retry', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { id } = z.object({ id: z.string() }).parse(request.params);

    const assignment = await prisma.competitionAssignment.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!assignment) return reply.code(404).send({ error: 'assignment not found' });

    const outcome = await pushAssignment(prisma, id);
    return reply.send({ outcome });
  });

  /** Drain the whole queue now, rather than waiting for the next cron tick. */
  app.post('/admin/assignments/drain', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    return reply.send({ summary: await drainAssignmentQueue() });
  });

  /** Look up what the roster says about one address, without changing anything. */
  app.get('/admin/roster/lookup', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { email } = z.object({ email: z.string() }).parse(request.query);
    const normalized = normalizeEmail(email);
    const resolution = await resolvePersona(prisma, email);
    const entry = await prisma.enrolledRosterEntry.findFirst({
      where: {
        OR: [
          { emailNormalized: normalized },
          { parentEmailNormalized: normalized },
          { parentEmail2Normalized: normalized },
        ],
      },
      select: {
        studentName: true,
        emailNormalized: true,
        programTypes: true,
        programTrack: true,
        active: true,
        lastSeenAt: true,
      },
    });
    return reply.send({ normalized, resolution, entry });
  });
}
