/**
 * Verification API — internal only.
 *
 * Every route here is gated on the ENROLLED policy, which is the one that allows
 * web verification. There is deliberately no public entry point: the TOF matcher
 * must never trigger a live search.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { policyFor } from '../../lib/persona.js';
import { requireUser } from '../auth/require-user.js';
import { applyVerification, verifyCompetition } from './verify.js';

export async function verificationRoutes(app: FastifyInstance): Promise<void> {
  /** Kick off a verification for one competition. Slow (live web search). */
  app.post(
    '/internal/competitions/:id/verify',
    { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;
      if (user.role !== 'INTERNAL' && user.role !== 'ADMIN') {
        return reply.code(403).send({ error: 'internal only' });
      }

      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = z
        .object({
          trigger: z
            .enum(['PRE_ACTIVATION', 'PERIODIC', 'PRE_MILESTONE', 'MANUAL'])
            .default('MANUAL'),
        })
        .parse(request.body ?? {});

      try {
        const result = await verifyCompetition(prisma, id, {
          policy: policyFor('ENROLLED'),
          trigger: body.trigger,
        });
        return reply.send(result);
      } catch (err) {
        request.log.error({ err }, 'verification failed');
        return reply
          .code(502)
          .send({ error: err instanceof Error ? err.message : 'verification failed' });
      }
    },
  );

  /** The human approval queue. */
  app.get('/internal/verifications', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (user.role !== 'INTERNAL' && user.role !== 'ADMIN') {
      return reply.code(403).send({ error: 'internal only' });
    }

    const query = z
      .object({
        status: z
          .enum(['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'NO_CHANGE', 'FAILED'])
          .default('PENDING_REVIEW'),
      })
      .parse(request.query);

    const events = await prisma.verificationEvent.findMany({
      where: { status: query.status },
      orderBy: { fetchedAt: 'desc' },
      take: 100,
      include: {
        competition: { select: { id: true, name: true, region: true, deadlineText: true } },
      },
    });

    return reply.send({ events });
  });

  /** Approve — the only path that writes verified dates onto a competition. */
  app.post('/internal/verifications/:id/approve', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (user.role !== 'INTERNAL' && user.role !== 'ADMIN') {
      return reply.code(403).send({ error: 'internal only' });
    }

    const { id } = z.object({ id: z.string() }).parse(request.params);
    try {
      const result = await applyVerification(prisma, id, user.id);
      return reply.send(result);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'apply failed' });
    }
  });

  app.post('/internal/verifications/:id/reject', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (user.role !== 'INTERNAL' && user.role !== 'ADMIN') {
      return reply.code(403).send({ error: 'internal only' });
    }

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const event = await prisma.verificationEvent.update({
      where: { id },
      data: { status: 'REJECTED', reviewedById: user.id, reviewedAt: new Date() },
      select: { id: true, status: true },
    });
    return reply.send({ event });
  });
}
