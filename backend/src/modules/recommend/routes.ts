import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { policyFor } from '../../lib/persona.js';
import { normalizeEmail } from '../../lib/persona.js';
import { requireUser } from '../auth/require-user.js';
import { redactForLockedLead } from '../leads/redact.js';
import { startEnrolledJourneyIfReady } from '../email/enroll.js';
import { generateRecommendations } from './pipeline.js';

/** A project the student has not yet accepted or rejected. */
async function pendingSheetProject(studentId: string) {
  return prisma.project.findFirst({
    where: { studentId, source: 'SHEET', confirmedAt: null, dismissedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, description: true, createdAt: true },
  });
}

const projectInput = z.object({
  name: z.string().max(200).optional(),
  domain: z.string().min(1).max(120),
  description: z.string().min(20, 'describe the project in at least a sentence').max(5000),
});

export async function recommendRoutes(app: FastifyInstance): Promise<void> {
  /** Create or update the caller's project. */
  app.post('/projects', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const parsed = projectInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid project' });
    }

    const student = await prisma.student.findUnique({ where: { userId: user.id } });
    const project = await prisma.project.create({
      data: {
        ...(student ? { studentId: student.id } : {}),
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        domain: parsed.data.domain,
        description: parsed.data.description,
        // Typing it in is the confirmation.
        confirmedAt: new Date(),
      },
    });

    // Naming a project is the other way the Flow 2 gate opens. Non-fatal: a
    // queue problem must not fail the project the student just created.
    if (student && parsed.data.name) {
      const started = await startEnrolledJourneyIfReady(prisma, student.id).catch(
        (err: unknown) => ({
          started: false as const,
          reason: err instanceof Error ? err.message : 'failed',
        }),
      );
      if (started.started) {
        request.log.info({ studentId: student.id }, 'Flow 2 started on project creation');
      }
    }

    return reply.code(201).send({ project });
  });

  /**
   * The project we already hold for an enrolled student, awaiting their
   * confirmation. Null for everyone else, so the client can simply always ask.
   */
  app.get('/projects/pending-confirmation', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const student = await prisma.student.findUnique({ where: { userId: user.id } });
    if (!student) return reply.send({ project: null });

    return reply.send({ project: await pendingSheetProject(student.id) });
  });

  /** "Yes, this is the project I want to continue with." */
  app.post('/projects/:id/confirm', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const student = await prisma.student.findUnique({ where: { userId: user.id } });
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project || project.studentId !== student?.id) {
      return reply.code(404).send({ error: 'project not found' });
    }

    const confirmed = await prisma.project.update({
      where: { id },
      data: { confirmedAt: new Date(), dismissedAt: null },
    });

    // Confirming a named project is also what opens the Flow 2 gate, if it was
    // waiting on one.
    if (student) {
      await startEnrolledJourneyIfReady(prisma, student.id).catch(() => undefined);
    }

    return reply.send({ project: confirmed });
  });

  /** "No — I want to work on something else." */
  app.post('/projects/:id/dismiss', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const student = await prisma.student.findUnique({ where: { userId: user.id } });
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project || project.studentId !== student?.id) {
      return reply.code(404).send({ error: 'project not found' });
    }

    // Kept rather than deleted: it is still CreatED's record of what this
    // student built, and the roster sync would recreate it anyway.
    const dismissed = await prisma.project.update({
      where: { id },
      data: { dismissedAt: new Date() },
    });
    return reply.send({ project: dismissed });
  });

  /**
   * Generate a recommendation set.
   *
   * Rate limited hard: this is the expensive path (two model calls plus
   * embeddings) and, on the TOF side, the one an abuser would hammer to mine the
   * repository.
   */
  app.post(
    '/recommendations',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;

      const parsed = z.object({ projectId: z.string() }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'projectId is required' });

      // One report per TOF account, for the life of the account. Once a report
      // has been delivered it is the report — reruns would let the same address
      // walk the repository one project description at a time, and would also
      // mean the email someone received no longer matches what they see.
      if (user.persona === 'TOF') {
        const lead = await prisma.lead.findUnique({
          where: { emailNormalized: normalizeEmail(user.email) },
          select: { firstReportRunId: true },
        });
        if (lead?.firstReportRunId) {
          const existing = await prisma.recommendationRun.findUnique({
            where: { id: lead.firstReportRunId },
            select: { id: true, items: { select: { id: true } } },
          });
          if (existing) {
            return reply.send({
              runId: existing.id,
              status: 'DELIVERED',
              itemCount: existing.items.length,
              reused: true,
              warning: 'You already have a report — this is the one we generated and emailed.',
            });
          }
        }
      }

      const student = await prisma.student.findUnique({ where: { userId: user.id } });
      const project = await prisma.project.findUnique({ where: { id: parsed.data.projectId } });
      if (!project) return reply.code(404).send({ error: 'project not found' });

      // A project belongs to one student; never let one account generate against
      // another's project.
      if (project.studentId && project.studentId !== student?.id) {
        return reply.code(403).send({ error: 'not your project' });
      }

      try {
        const result = await generateRecommendations(prisma, {
          projectId: project.id,
          persona: user.persona,
          student: {
            grade: student?.grade ?? null,
            age: student?.age ?? null,
            country: student?.country ?? null,
          },
        });
        return reply.send(result);
      } catch (err) {
        request.log.error({ err }, 'recommendation generation failed');
        const message = err instanceof Error ? err.message : 'generation failed';
        return reply.code(502).send({ error: message });
      }
    },
  );

  /**
   * Read a run.
   *
   * An enrolled run stays invisible to the client until the internal team has
   * approved it — the requirement is explicit that AI output is reviewed before
   * it becomes client-facing.
   */
  app.get('/recommendations/:id', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const run = await prisma.recommendationRun.findUnique({
      where: { id },
      include: { project: true },
    });
    if (!run) return reply.code(404).send({ error: 'not found' });

    const student = await prisma.student.findUnique({ where: { userId: user.id } });
    const isOwner = run.project.studentId != null && run.project.studentId === student?.id;
    const isInternal = user.role === 'INTERNAL' || user.role === 'ADMIN';
    if (!isOwner && !isInternal) return reply.code(403).send({ error: 'not yours' });

    const policy = policyFor(user.persona);
    if (policy.requiresInternalApproval && !isInternal && run.status !== 'APPROVED') {
      return reply.code(409).send({
        error: 'awaiting internal review',
        status: run.status,
      });
    }

    // TOF sees one free result until they have unlocked. Enforced here rather
    // than in the UI, so the locked competitions are absent from the response
    // body, not merely hidden by CSS.
    let payload: unknown = run.payload;
    let lockedCount = 0;
    if (user.persona === 'TOF' && !isInternal) {
      const unlocked = await hasUnlocked(user.email);
      if (!unlocked) {
        const redacted = redactForLockedLead(run.payload);
        payload = redacted.payload;
        lockedCount = redacted.lockedCount;
      }
    }

    return reply.send({
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
      payload,
      lockedCount,
      // The retrieval trace is a debugging surface: it names competitions that
      // were dropped, which is exactly what the public flow must not expose.
      ...(isInternal ? { retrievalTrace: run.retrievalTrace } : {}),
    });
  });

  /** Latest run for a project, for the dashboard to poll after generating. */
  app.get('/projects/:id/recommendations', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const student = await prisma.student.findUnique({ where: { userId: user.id } });
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) return reply.code(404).send({ error: 'project not found' });
    if (project.studentId && project.studentId !== student?.id) {
      return reply.code(403).send({ error: 'not your project' });
    }

    const run = await prisma.recommendationRun.findFirst({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
    });
    if (!run) return reply.send({ run: null });

    const policy = policyFor(user.persona);
    const visible = !policy.requiresInternalApproval || run.status === 'APPROVED';

    let payload: unknown = run.payload;
    let lockedCount = 0;
    if (user.persona === 'TOF' && !(await hasUnlocked(user.email))) {
      const redacted = redactForLockedLead(run.payload);
      payload = redacted.payload;
      lockedCount = redacted.lockedCount;
    }

    return reply.send({
      run: {
        id: run.id,
        status: run.status,
        createdAt: run.createdAt,
        lockedCount,
        ...(visible ? { payload } : {}),
      },
    });
  });
}

/** Has this address already passed the lead gate? */
async function hasUnlocked(email: string): Promise<boolean> {
  const lead = await prisma.lead.findUnique({
    where: { emailNormalized: normalizeEmail(email) },
    select: { firstReportRunId: true },
  });
  return Boolean(lead?.firstReportRunId);
}
