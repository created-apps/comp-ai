import type { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { config, isProd } from '../../lib/config.js';
import { normalizeEmail, policyFor } from '../../lib/persona.js';
import { resolvePersonaForSignup, rosterProjectFor } from '../roster/verify-signup.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from './jwt.js';
import { startJourneyForSignup } from '../email/on-signup.js';

const REFRESH_COOKIE = 'comp_ai_refresh';

const login = z.object({
  email: z.string().email(),
  password: z.string().min(10, 'password must be at least 10 characters'),
});

/**
 * Signup is deliberately minimal.
 *
 * The full profile — phone, grade, school, city, country — is collected at the
 * lead gate instead, after the student has seen a match worth trading details
 * for. Asking for all of it up front is a wall in front of a stranger who has
 * not yet been shown anything.
 */
const signupInput = login.extend({
  name: z.string().trim().min(1).optional(),
});

function refreshCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isProd,
    path: '/auth',
    maxAge: 60 * 60 * 24 * 30,
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Signup. The persona is resolved here from the roster synced out of the
   * Google Sheet — this single lookup is what decides whether the user lands in
   * the Enrolled Competition OS or the TOF matcher.
   */
  app.post('/auth/signup', async (request, reply) => {
    const parsed = signupInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid input' });
    }
    const { email, password, name } = parsed.data;
    const emailNormalized = normalizeEmail(email);

    const existing = await prisma.user.findUnique({ where: { emailNormalized } });
    if (existing) {
      // Do not reveal which addresses are registered.
      return reply.code(409).send({ error: 'could not create account' });
    }

    // Verified against the live sheet, not just the 5-hourly mirror: a student
    // added to the sheet this morning must not be handed the public flow.
    const resolution = await resolvePersonaForSignup(prisma, email);
    if (resolution.liveCheck === 'FAILED') {
      request.log.warn(
        { email: emailNormalized, err: resolution.liveCheckError },
        'live sheet check failed at signup; used the local roster',
      );
    }
    const passwordHash = await argon2.hash(password);

    // An enrolled family already has a project on the programme sheet. Bring it
    // across now so the student is asked to confirm it rather than being handed
    // an empty form for work we already know about.
    const rosterProject =
      resolution.persona === 'ENROLLED' ? await rosterProjectFor(prisma, email) : null;

    const user = await prisma.user.create({
      data: {
        email,
        emailNormalized,
        passwordHash,
        persona: resolution.persona,
        ...(name || rosterProject
          ? {
              student: {
                create: {
                  name: name ?? rosterProject?.studentName ?? 'there',
                  ...(rosterProject
                    ? {
                        projects: {
                          create: {
                            name: rosterProject.name,
                            description:
                              rosterProject.description ?? rosterProject.name ?? '',
                            source: 'SHEET',
                            // Deliberately unconfirmed: the student has not yet
                            // said this is what they want to continue with.
                          },
                        },
                      }
                    : {}),
                },
              },
            }
          : {}),
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: 'USER_SIGNUP',
        entity: 'User',
        entityId: user.id,
        after: {
          persona: resolution.persona,
          reason: resolution.reason,
          liveSheetCheck: resolution.liveCheck,
        },
      },
    });

    // Fire the matching email flow. Deliberately awaited but non-throwing: the
    // publish is a fast Redis write, and knowing at signup time that the queue
    // is unreachable is worth more than shaving a few milliseconds.
    const emails = await startJourneyForSignup(prisma, {
      userId: user.id,
      email: user.email,
      persona: user.persona,
      ...(name ? { studentName: name } : {}),
    });
    if ('error' in emails) {
      request.log.error({ err: emails.error, userId: user.id }, 'could not schedule signup emails');
    } else {
      request.log.info({ userId: user.id, ...emails }, 'signup email journey scheduled');
    }

    const accessToken = signAccessToken({
      sub: user.id,
      role: user.role,
      persona: user.persona,
      ver: user.tokenVersion,
    });
    reply.setCookie(
      REFRESH_COOKIE,
      signRefreshToken({ sub: user.id, ver: user.tokenVersion }),
      refreshCookieOptions(),
    );

    return reply.code(201).send({
      accessToken,
      user: { id: user.id, email: user.email, role: user.role, persona: user.persona },
      policy: policyFor(user.persona),
    });
  });

  app.post('/auth/login', async (request, reply) => {
    const parsed = login.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid credentials' });
    }
    const emailNormalized = normalizeEmail(parsed.data.email);
    const user = await prisma.user.findUnique({ where: { emailNormalized } });

    // Constant-ish work whether or not the user exists, so timing doesn't
    // disclose which addresses are registered.
    const ok =
      user?.passwordHash != null
        ? await argon2.verify(user.passwordHash, parsed.data.password).catch(() => false)
        : await argon2
            .hash(parsed.data.password)
            .then(() => false)
            .catch(() => false);

    if (!user || !ok) {
      return reply.code(401).send({ error: 'invalid credentials' });
    }

    reply.setCookie(
      REFRESH_COOKIE,
      signRefreshToken({ sub: user.id, ver: user.tokenVersion }),
      refreshCookieOptions(),
    );

    return reply.send({
      accessToken: signAccessToken({
        sub: user.id,
        role: user.role,
        persona: user.persona,
        ver: user.tokenVersion,
      }),
      user: { id: user.id, email: user.email, role: user.role, persona: user.persona },
      policy: policyFor(user.persona),
    });
  });

  app.post('/auth/refresh', async (request, reply) => {
    const token = request.cookies[REFRESH_COOKIE];
    if (!token) return reply.code(401).send({ error: 'no refresh token' });

    let claims;
    try {
      claims = verifyRefreshToken(token);
    } catch {
      return reply.code(401).send({ error: 'invalid refresh token' });
    }

    const user = await prisma.user.findUnique({ where: { id: claims.sub } });
    if (!user || user.tokenVersion !== claims.ver) {
      return reply.code(401).send({ error: 'session revoked' });
    }

    // Persona is re-read from the database, so a roster sync takes effect on the
    // next refresh without forcing the user to log in again.
    return reply.send({
      accessToken: signAccessToken({
        sub: user.id,
        role: user.role,
        persona: user.persona,
        ver: user.tokenVersion,
      }),
      user: { id: user.id, email: user.email, role: user.role, persona: user.persona },
      policy: policyFor(user.persona),
    });
  });

  app.post('/auth/logout', async (_request, reply) => {
    reply.clearCookie(REFRESH_COOKIE, { path: '/auth' });
    return reply.send({ ok: true });
  });

  app.get('/auth/me', async (request, reply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'missing token' });
    }
    let claims;
    try {
      claims = verifyAccessToken(header.slice(7));
    } catch {
      return reply.code(401).send({ error: 'invalid token' });
    }

    const user = await prisma.user.findUnique({
      where: { id: claims.sub },
      include: { student: { include: { enrolments: true } } },
    });
    if (!user || user.tokenVersion !== claims.ver) {
      return reply.code(401).send({ error: 'session revoked' });
    }

    return reply.send({
      user: { id: user.id, email: user.email, role: user.role, persona: user.persona },
      policy: policyFor(user.persona),
      student: user.student,
    });
  });
}

export { REFRESH_COOKIE, config };
