import { fileURLToPath } from 'node:url';
import { z } from 'zod';

try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch {
  // no .env on disk; use the real environment
}

/**
 * An optional env var that is present but blank is *not* set.
 *
 * `.env` files ship keys with empty values (EMAIL_REDIRECT_TO=), so plain
 * `.optional()` yields "" rather than undefined — and `??` does not treat "" as
 * missing. That turned the send recipient into an empty string and SendGrid
 * rejected it with "Does not contain a valid address". Normalising here means
 * every consumer can use `??`, `||` or `!value` and get the same answer.
 */
const optionalString = () =>
  z
    .string()
    .transform((v) => v.trim())
    .transform((v) => (v === '' ? undefined : v))
    .optional();

const schema = z.object({
  REDIS_URL: z.string().default('redis://localhost:6379'),
  SENDGRID_API_KEY: optionalString(),
  EMAIL_FROM: z.string().min(3),
  EMAIL_FROM_NAME: z.string().default('Team CreatED'),
  /** Staging safety valve: redirect every send to one inbox. Blank means off. */
  EMAIL_REDIRECT_TO: optionalString(),
  EMAIL_SEND_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  WORKER_CONCURRENCY: z.coerce.number().min(1).max(50).default(5),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error(
    'Invalid environment:\n' +
      parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
  );
  process.exit(1);
}

export const config = parsed.data;

// A worker that boots without credentials and silently drops every job is worse
// than one that refuses to start.
if (config.EMAIL_SEND_ENABLED && !config.SENDGRID_API_KEY) {
  console.error('SENDGRID_API_KEY is required unless EMAIL_SEND_ENABLED=false');
  process.exit(1);
}
