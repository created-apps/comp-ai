import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireUser } from '../auth/require-user.js';
import { refreshTopPicks } from '../recommend/top-picks.js';
import { startEnrolledJourney } from './enroll.js';

export async function emailRoutes(app: FastifyInstance): Promise<void> {
  /** Recompute one student's three picks on demand, before emailing them. */
  app.post('/internal/students/:id/top-picks', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (user.role !== 'INTERNAL' && user.role !== 'ADMIN') {
      return reply.code(403).send({ error: 'internal only' });
    }

    const { id } = z.object({ id: z.string() }).parse(request.params);
    const result = await refreshTopPicks(prisma, { studentId: id, force: true });
    const picks = await prisma.enrolledTopPicks.findUnique({ where: { studentId: id } });
    return reply.send({ result, picks });
  });

  /**
   * Start Flow 2 for a student. Internal-only and explicit: emailing families is
   * not something an automated path should trigger without a person deciding.
   */
  app.post('/internal/students/:id/email-journey', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (user.role !== 'INTERNAL' && user.role !== 'ADMIN') {
      return reply.code(403).send({ error: 'internal only' });
    }

    const { id } = z.object({ id: z.string() }).parse(request.params);
    try {
      const result = await startEnrolledJourney(prisma, id);
      return reply.send(result);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  /** What is currently saved for a student, for the internal console. */
  app.get('/internal/students/:id/top-picks', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (user.role !== 'INTERNAL' && user.role !== 'ADMIN') {
      return reply.code(403).send({ error: 'internal only' });
    }
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const picks = await prisma.enrolledTopPicks.findUnique({ where: { studentId: id } });
    return reply.send({ picks });
  });
}
