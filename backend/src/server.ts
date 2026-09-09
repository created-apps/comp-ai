import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { allowAnyOrigin, config, isProd, webOrigins } from './lib/config.js';
import { prisma } from './lib/prisma.js';
import { pendingMigrations } from './lib/schema-check.js';
import { authRoutes } from './modules/auth/routes.js';
import { adminRoutes } from './modules/admin/routes.js';
import { recommendRoutes } from './modules/recommend/routes.js';
import { entitlementRoutes } from './modules/entitlement/routes.js';
import { verificationRoutes } from './modules/verification/routes.js';
import { startRosterScheduler } from './modules/roster/scheduler.js';
import { startTopPicksScheduler } from './modules/recommend/top-picks-job.js';
import { startCosmicRetryScheduler } from './modules/cosmic/retry-job.js';
import { startVerificationScheduler } from './modules/verification/scheduler.js';
import { emailRoutes } from './modules/email/routes.js';
import { leadRoutes } from './modules/leads/routes.js';
import { chatRoutes } from './modules/chat/routes.js';

export async function buildServer() {
  const app = Fastify({
    logger: isProd ? true : { level: 'info' },
  });

  // Several endpoints are bodyless POSTs (logout, refresh). Fastify's default
  // JSON parser rejects an empty body outright, so a client that sets the JSON
  // content-type without one gets a 400 it cannot diagnose. Treat empty as {}.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string, done) => {
      if (body === '' || body == null) return done(null, {});
      try {
        done(null, JSON.parse(body) as unknown);
      } catch (err) {
        const error = err as Error & { statusCode?: number };
        error.statusCode = 400;
        done(error, undefined);
      }
    },
  );

  // CORS. No cookies are set anywhere in this API, so nothing here is
  // credentialed: the browser sends session and admin tokens in the
  // Authorization header, which an ordinary cross-origin request carries.
  //
  // The origin is always REFLECTED, never answered with a literal "*". A
  // wildcard is the single value a browser refuses when the caller's request is
  // credentialed — "the value of the 'Access-Control-Allow-Origin' header must
  // not be the wildcard '*' when the request's credentials mode is 'include'" —
  // so a client still sending credentials (an older bundle, a stray
  // `credentials: 'include'`) fails at the preflight with a message that reads
  // like a server misconfiguration. Reflecting the caller's own origin is
  // accepted either way, and costs nothing.
  //
  // WEB_ORIGIN is the allowlist, comma-separated: production plus previews.
  await app.register(cors, {
    origin(origin, cb) {
      // No Origin header at all — curl, a health check, server-to-server.
      if (!origin) return cb(null, true);
      cb(null, allowAnyOrigin || webOrigins.includes(origin.replace(/\/$/, '')));
    },
    // The library's default stops at GET,HEAD,POST. The admin console's PUT and
    // PATCH calls are preflighted, and would be refused before reaching a route.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    // A day of preflight caching; every authed call would otherwise pay for one.
    maxAge: 86_400,
  });
  // Baseline limit. The public matcher and the chatbot get much tighter,
  // per-route limits — those surfaces are how the repository would be mined.
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  app.get('/health', async () => {
    const schema = await pendingMigrations(prisma);
    const [competitions, rosterEntries, lastSync] = await Promise.all([
      prisma.competition.count(),
      prisma.enrolledRosterEntry.count({ where: { active: true } }),
      prisma.sheetSyncRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    ]);

    return {
      ok: true,
      competitions,
      rosterEntries,
      lastRosterSync: lastSync
        ? { at: lastSync.startedAt, status: lastSync.status, rows: lastSync.rowsSeen }
        : null,
      pendingMigrations: schema.pending,
      // An empty roster means every signup resolves to TOF — worth shouting about.
      warning:
        schema.pending.length > 0
          ? `${schema.pending.length} migration(s) not applied — run: npm run db:migrate`
          : rosterEntries === 0
            ? 'roster is empty: all signups resolve to TOF'
            : undefined,
    };
  });

  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(recommendRoutes);
  await app.register(entitlementRoutes);
  await app.register(verificationRoutes);
  await app.register(emailRoutes);
  await app.register(leadRoutes);
  await app.register(chatRoutes);

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildServer();
  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });

    // Loud at boot rather than a 500 on whichever route touches the new column
    // first. Not fatal: a read-only replica or a deploy mid-rollout is a valid
    // reason to be briefly behind.
    const schema = await pendingMigrations(prisma);
    if (schema.error) {
      app.log.warn({ err: schema.error }, 'could not check migration state');
    } else if (schema.pending.length > 0) {
      app.log.error(
        { pending: schema.pending },
        `DATABASE IS BEHIND: ${schema.pending.length} migration(s) not applied. ` +
          'Run `npm run db:migrate` — queries touching new columns will fail until you do.',
      );
    }

    startRosterScheduler(app.log);
    startTopPicksScheduler(app.log);
    startCosmicRetryScheduler(app.log);
    startVerificationScheduler(app.log);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
