import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Persona, Role } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { verifyAccessToken } from './jwt.js';

export interface AuthedUser {
  id: string;
  email: string;
  role: Role;
  persona: Persona;
}

/**
 * Resolve the caller from the Bearer token.
 *
 * The persona is re-read from the database rather than trusted from the token
 * claim: a roster sync or an admin override must take effect on the next request,
 * not whenever the access token happens to expire.
 *
 * Returns null and sends the response when unauthenticated.
 */
export async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthedUser | null> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    await reply.code(401).send({ error: 'missing token' });
    return null;
  }

  let claims;
  try {
    claims = verifyAccessToken(header.slice(7));
  } catch {
    await reply.code(401).send({ error: 'invalid token' });
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: { id: true, email: true, role: true, persona: true, tokenVersion: true },
  });

  if (!user || user.tokenVersion !== claims.ver) {
    await reply.code(401).send({ error: 'session revoked' });
    return null;
  }

  return { id: user.id, email: user.email, role: user.role, persona: user.persona };
}
