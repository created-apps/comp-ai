import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load backend/.env before validating. Node has this built in (>=20.12), so the
// backend carries no dotenv dependency. A missing file is fine — in production
// the environment is supplied by the platform, not a file.
try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch {
  // no .env on disk; fall through to the real environment
}

/**
 * An optional env var that is present but blank is *not* set.
 *
 * `.env` files ship keys with empty values (CHROMA_TENANT=), so plain
 * `.optional()` yields "" rather than undefined, and `??` does not treat "" as
 * missing. Normalising here means every consumer can use `??`, `||` or `!value`
 * and get the same answer.
 */
const optionalString = () =>
  z
    .string()
    .transform((v) => v.trim())
    .transform((v) => (v === '' ? undefined : v))
    .optional();

/**
 * Fail fast and loudly on misconfiguration. A missing JWT secret must stop the
 * process at boot, not produce unverifiable tokens at 3am.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  // Comma-separated when the API serves more than one front end (a Vercel
  // production domain plus preview deployments, say). The first entry is the
  // canonical one: it is what deep links in internal emails point at.
  WEB_ORIGIN: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),

  CHROMA_MODE: z.enum(['cloud', 'http']).default('cloud'),
  CHROMA_TENANT: optionalString(),
  CHROMA_DATABASE: optionalString(),
  CHROMA_API_KEY: optionalString(),
  CHROMA_HOST: z.string().default('localhost'),
  CHROMA_PORT: z.coerce.number().default(8000),
  CHROMA_COLLECTION: z.string().default('competitions_v1'),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 chars'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 chars'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  ANTHROPIC_API_KEY: optionalString(),
  CLAUDE_MODEL: z.string().default('claude-opus-5'),
  /**
   * Verification runs on its own model, and a cheaper one.
   *
   * It is the highest-volume model call in the system — every competition in the
   * repository, repeated as it goes stale — and it is not the hardest: read the
   * organiser's page, report what it says, refuse to guess. The pipeline that
   * decides which competitions suit a student's project is where the stronger
   * model earns its cost. Six turns of page-reading is where it does not.
   */
  VERIFICATION_MODEL: z.string().default('claude-sonnet-5'),

  // ---- email ----
  // The backend only publishes to this queue; SendGrid credentials live in the
  // email worker, which is the only service that talks to the provider.
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // ---- top-3 competition picks for the enrolled email flow ----
  TOP_PICKS_CRON: z.string().default('0 2 * * *'),
  TOP_PICKS_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  TOP_PICKS_BATCH_LIMIT: z.coerce.number().default(50),

  // ---- competition verification against the official source ----
  // Every row is ingested from a spreadsheet and unverified until something
  // checks it. Each check is a multi-turn web search, so the sweep is small and
  // frequent rather than a full pass: it works through the competitions students
  // actually hold first. Set true on exactly ONE instance.
  VERIFICATION_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  VERIFICATION_CRON: z.string().default('0 * * * *'),
  VERIFICATION_BATCH_LIMIT: z.coerce.number().default(5),
  VERIFICATION_STALE_DAYS: z.coerce.number().default(30),
  VERIFICATION_DEADLINE_WINDOW_DAYS: z.coerce.number().default(45),
  VERIFICATION_COOLDOWN_HOURS: z.coerce.number().default(20),

  // ---- internal review notifications ----
  // Comma-separated. These people are emailed whenever an enrolled student's
  // recommendations enter PENDING_REVIEW, with a link into /admin to act on it.
  // Empty means nobody is notified — the queue still fills, silently.
  INTERNAL_REVIEW_EMAILS: optionalString(),

  // ---- google sheet roster ----
  // The service account JSON key, base64-encoded. Base64 because the private key
  // is a multi-line PEM block: pasting it raw into an env var turns the newlines
  // into literal "\n" and every signature fails.
  //   base64 -i service-account.json | tr -d '\n'
  GOOGLE_SERVICE_ACCOUNT_JSON: optionalString(),
  ROSTER_SHEET_ID: optionalString(),
  ROSTER_SHEET_TAB: z.string().default('Sheet1'),
  ROSTER_SYNC_CRON: z.string().default('0 */5 * * *'),
  ROSTER_SYNC_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // ---- entitlement ----
  // How many competitions an enrolled student may activate when no
  // ProgramEnrolment has been set for them by hand in /admin.
  DEFAULT_COMPETITION_ALLOWANCE: z.coerce.number().default(2),

  // ---- COSMIC (the operational system the student actually works in) ----
  // comp-ai authenticates as a COSMIC user with role=manager, exactly as the
  // SYNC integration does. Selection never depends on COSMIC being reachable:
  // assignments are queued and retried, so a blank config only means "nothing
  // is pushed yet", never a failed selection.
  COSMIC_API_URL: optionalString(),
  COSMIC_SERVICE_EMAIL: optionalString(),
  COSMIC_SERVICE_PASSWORD: optionalString(),
  COSMIC_PUSH_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  COSMIC_RETRY_CRON: z.string().default('*/30 * * * *'),
  COSMIC_MAX_ATTEMPTS: z.coerce.number().default(8),
  COSMIC_RETRY_BATCH_LIMIT: z.coerce.number().default(50),

  // Simple shared password for the internal admin console. Not a user account:
  // it gates a small operations surface, and rotating it is an env change.
  ADMIN_PASSWORD: z.string().min(8, 'ADMIN_PASSWORD must be at least 8 chars'),
  ADMIN_SESSION_TTL: z.string().default('8h'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:\n' + parsed.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}

export const config = parsed.data;
export const isProd = config.NODE_ENV === 'production';

/** Every origin allowed to call this API. */
export const webOrigins: string[] = config.WEB_ORIGIN.split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);

/**
 * Accept any caller. Set while the front end's domain is still moving —
 * WEB_ORIGIN=* or left blank — and worth tightening to a real list once it has
 * settled. Note this never becomes a literal `*` in the response: the server
 * reflects the caller's own origin instead, which a browser accepts whether or
 * not the request is credentialed.
 */
export const allowAnyOrigin: boolean = webOrigins.length === 0 || webOrigins.includes('*');

/**
 * The one to put in an email — a link has to pick a single front end, and "*"
 * is not a URL. Falls back to localhost so a misconfigured deployment produces
 * an obviously wrong link rather than a broken one.
 */
export const primaryWebOrigin: string =
  webOrigins.find((origin) => origin !== '*') ?? 'http://localhost:3000';
