import type { FastifyInstance, FastifyRequest } from 'fastify';
import argon2 from 'argon2';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../lib/config.js';
import { normalizeEmail, policyFor } from '../../lib/persona.js';
import { resolvePersonaForSignup, rosterProjectFor } from '../roster/verify-signup.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from './jwt.js';
import { startJourneyForSignup } from '../email/on-signup.js';

/**
 * Tokens are returned in the response body, not set as cookies.
 *
 * The front end is served from Vercel and this API from Railway, so every
 * credentialed request is cross-site. A cookie survives that only as
 * `SameSite=None; Secure`, which browsers increasingly restrict and which no
 * amount of correct configuration makes reliable across two vendors' domains —
 * the symptom is a valid refresh token the browser holds and never sends, and
 * `/auth/refresh` answering 401 on every page load.
 *
 * So the client stores both tokens itself and presents them as bearer tokens.
 * The trade is deliberate and worth stating: a token in localStorage is readable
 * by any script that runs on the page, where an HttpOnly cookie is not. What
 * protects the session is therefore the short access-token TTL and
 * `tokenVersion` — bumping it on the user invalidates every outstanding token —
 * rather than the browser withholding the value.
 */

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

/**
 * The refresh token: `{ refreshToken }` in the body, or a bearer header.
 *
 * The body is checked FIRST and that order matters. A client's generic request
 * helper attaches the *access* token to the Authorization header on every call;
 * preferring the header here would read that stale access token instead of the
 * refresh token sitting in the body, fail to verify it against the refresh
 * secret, and answer 401 to a session that is perfectly valid. Explicit beats
 * ambient.
 */
function refreshTokenFrom(request: FastifyRequest): string | null {
  const body = request.body;
  if (body && typeof body === 'object' && 'refreshToken' in body) {
    const value = (body as { refreshToken: unknown }).refreshToken;
    if (typeof value === 'string' && value.length > 0) return value;
  }

  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);

  return null;
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
    return reply.code(201).send({
      accessToken,
      refreshToken: signRefreshToken({ sub: user.id, ver: user.tokenVersion }),
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

    return reply.send({
      accessToken: signAccessToken({
        sub: user.id,
        role: user.role,
        persona: user.persona,
        ver: user.tokenVersion,
      }),
      refreshToken: signRefreshToken({ sub: user.id, ver: user.tokenVersion }),
      user: { id: user.id, email: user.email, role: user.role, persona: user.persona },
      policy: policyFor(user.persona),
    });
  });

  app.post('/auth/refresh', async (request, reply) => {
    const token = refreshTokenFrom(request);
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
      // Reissued so an active session slides forward rather than expiring 30
      // days after the login that started it.
      refreshToken: signRefreshToken({ sub: user.id, ver: user.tokenVersion }),
      user: { id: user.id, email: user.email, role: user.role, persona: user.persona },
      policy: policyFor(user.persona),
    });
  });

  /**
   * Logout is the client discarding its tokens; there is no cookie to clear and
   * no server-side session to end. An outstanding token stays valid until it
   * expires — to end every session on every device, bump the user's
   * `tokenVersion`, which is what `requireUser` and `/auth/refresh` check.
   */
  app.post('/auth/logout', async (_request, reply) => {
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

export { config };
