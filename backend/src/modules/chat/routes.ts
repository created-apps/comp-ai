/**
 * Competition AI routes — enrolled students only.
 *
 * The persona check is the first thing each route does. A TOF user would need a
 * different tool surface (public DTOs, per-session caps, an enumeration guard),
 * so rather than serve them a half-safe version they are refused outright.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { requireUser } from '../auth/require-user.js';
import { ask, history } from './service.js';

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/chat',
    { config: { rateLimit: { max: 30, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const user = await requireUser(request, reply);
      if (!user) return;

      if (user.persona !== 'ENROLLED') {
        return reply.code(403).send({
          error: 'Competition AI is available to enrolled CreatED students.',
        });
      }

      const parsed = z
        .object({ message: z.string().trim().min(1).max(2000), sessionId: z.string().optional() })
        .safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'message is required' });

      const student = await prisma.student.findUnique({ where: { userId: user.id } });
      if (!student) return reply.code(400).send({ error: 'no student profile on this account' });

      try {
        const result = await ask(prisma, {
          studentId: student.id,
          userId: user.id,
          message: parsed.data.message,
          ...(parsed.data.sessionId ? { sessionId: parsed.data.sessionId } : {}),
        });
        return reply.send(result);
      } catch (err) {
        request.log.error({ err }, 'chat failed');
        return reply
          .code(502)
          .send({ error: err instanceof Error ? err.message : 'could not answer' });
      }
    },
  );

  app.get('/chat/:sessionId', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (user.persona !== 'ENROLLED') {
      return reply.code(403).send({ error: 'Competition AI is available to enrolled students.' });
    }

    const { sessionId } = z.object({ sessionId: z.string() }).parse(request.params);
    const session = await history(prisma, user.id, sessionId);
    if (!session) return reply.code(404).send({ error: 'not found' });
    return reply.send(session);
  });
}
