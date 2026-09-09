/**
 * Selection API — the enrolled student's half of PLAN.md 7.1.
 *
 * Three routes: what am I entitled to, here is what I choose, and what did I end
 * up with. All three are ENROLLED-only; a TOF account has no entitlement, no
 * selection and no workspace, and the persona check is here rather than in the
 * UI so the endpoints cannot be reached by a redirected client.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { policyFor } from '../../lib/persona.js';
import { requireUser } from '../auth/require-user.js';
import { serializeCompetition } from '../competitions/dto.js';
import { pushAssignments } from '../cosmic/assign.js';
import { verifyOnActivation } from '../verification/sweep.js';
import { config } from '../../lib/config.js';
import { getEntitlement } from './allowance.js';
import { selectCompetitions, SelectionError } from './select.js';

/** Plain-language status for the student. They should never read an enum. */
const ASSIGNMENT_COPY: Record<string, string> = {
  SENT: 'Ready in your CreatED workspace',
  READY: 'We are setting this up for you',
  WAITING_FOR_STUDENT: 'We are setting this up for you',
  WAITING_FOR_PROJECT: 'We are setting this up for you',
  FAILED: 'We are setting this up for you',
};

export async function entitlementRoutes(app: FastifyInstance): Promise<void> {
  /** What the student's program allows, and what they have spent. */
  app.get('/entitlement', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (user.persona !== 'ENROLLED') {
      return reply.send({ entitlement: null });
    }

    const student = await prisma.student.findUnique({ where: { userId: user.id } });
    if (!student) return reply.send({ entitlement: null });

    const { usedCompetitionIds, ...entitlement } = await getEntitlement(prisma, student.id);
    return reply.send({ entitlement: { ...entitlement, activeCompetitionIds: usedCompetitionIds } });
  });

  /**
   * "These are the ones I want."
   *
   * Selection activates immediately: the internal review gate already happened
   * when the run was approved, so there is no second human step between a
   * student choosing and their workspace existing. The COSMIC push is fired
   * afterwards and deliberately not awaited into the response's success — a
   * queued assignment is a normal outcome, and COSMIC being down must not cost
   * the student their selection.
   */
  app.post('/recommendations/:id/select', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (user.persona !== 'ENROLLED') {
      return reply.code(403).send({ error: 'selection is for enrolled students' });
    }

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const parsed = z
      .object({ competitionIds: z.array(z.string()).min(1).max(20) })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'competitionIds is required' });
    }

    const student = await prisma.student.findUnique({ where: { userId: user.id } });
    if (!student) return reply.code(404).send({ error: 'student profile not found' });

    let result;
    try {
      result = await selectCompetitions(prisma, {
        studentId: student.id,
        runId: id,
        competitionIds: parsed.data.competitionIds,
      });
    } catch (err) {
      if (err instanceof SelectionError) {
        return reply.code(err.status).send({ error: err.message, code: err.code, ...err.detail });
      }
      throw err;
    }

    const outcomes = await pushAssignments(
      prisma,
      result.activated.map((a) => a.assignmentId),
    ).catch((err: unknown) => {
      request.log.error({ err }, 'COSMIC assignment push failed; rows stay queued');
      return [];
    });

    // Pre-activation verification (PLAN.md 7.3). Deliberately not awaited: it is
    // a web search per competition, roughly a minute each, and the student's
    // confirmation must not wait on it. It writes proposals into the review
    // queue; it never changes a stored date on its own.
    if (config.VERIFICATION_ENABLED && result.activated.length > 0) {
      void verifyOnActivation(
        prisma,
        result.activated.map((a) => a.competitionId),
        { cooldownHours: config.VERIFICATION_COOLDOWN_HOURS },
      )
        .then((summary) => {
          if (summary.pendingReview > 0) {
            request.log.warn(
              { pendingReview: summary.pendingReview, studentId: student.id },
              'pre-activation verification found changes awaiting review',
            );
          }
        })
        .catch((err: unknown) =>
          request.log.error({ err }, 'pre-activation verification failed'),
        );
    }

    const { usedCompetitionIds, ...entitlement } = result.entitlement;
    return reply.send({
      activated: result.activated.map((a) => ({
        competitionId: a.competitionId,
        slug: a.slug,
        name: a.name,
        assignment:
          outcomes.find((o) => o.assignmentId === a.assignmentId)?.status ?? 'READY',
      })),
      alreadyActive: result.alreadyActive,
      entitlement: { ...entitlement, activeCompetitionIds: usedCompetitionIds },
    });
  });

  /** The competitions this student actually owns, with where they are. */
  app.get('/me/competitions', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (user.persona !== 'ENROLLED') return reply.send({ competitions: [] });

    const student = await prisma.student.findUnique({ where: { userId: user.id } });
    if (!student) return reply.send({ competitions: [] });

    const assignments = await prisma.competitionAssignment.findMany({
      where: { studentId: student.id },
      orderBy: { createdAt: 'asc' },
      include: {
        competition: { include: { milestones: { orderBy: { order: 'asc' } } } },
        recommendationItem: { select: { reason: true, fitBucket: true, activatedAt: true } },
      },
    });

    const policy = policyFor('ENROLLED');
    return reply.send({
      competitions: assignments.map((a) => ({
        // Activated, so the internal view is the correct one — guidance unlocks
        // on activation, which is exactly what this list represents.
        competition: serializeCompetition(a.competition, policy, {
          activated: true,
          milestones: a.competition.milestones,
        }),
        reason: a.recommendationItem.reason,
        fitBucket: a.recommendationItem.fitBucket,
        activatedAt: a.recommendationItem.activatedAt,
        workspace: {
          ready: a.status === 'SENT',
          status: ASSIGNMENT_COPY[a.status] ?? 'We are setting this up for you',
        },
      })),
    });
  });
}
