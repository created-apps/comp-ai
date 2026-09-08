import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * `.env` files ship optional keys with empty values (EMAIL_REDIRECT_TO=), so a
 * plain `.optional()` yields "" rather than undefined. `??` does not treat ""
 * as missing, which made the send recipient an empty string and produced
 * SendGrid's opaque "Does not contain a valid address".
 *
 * This pins the normalisation the config uses.
 */
const optionalString = () =>
  z
    .string()
    .transform((v) => v.trim())
    .transform((v) => (v === '' ? undefined : v))
    .optional();

const schema = z.object({ EMAIL_REDIRECT_TO: optionalString() });

describe('blank optional env vars', () => {
  it('treats an empty value as unset', () => {
    expect(schema.parse({ EMAIL_REDIRECT_TO: '' }).EMAIL_REDIRECT_TO).toBeUndefined();
  });

  it('treats a whitespace-only value as unset', () => {
    expect(schema.parse({ EMAIL_REDIRECT_TO: '   ' }).EMAIL_REDIRECT_TO).toBeUndefined();
  });

  it('makes ?? fall through to the real recipient', () => {
    const { EMAIL_REDIRECT_TO } = schema.parse({ EMAIL_REDIRECT_TO: '' });
    expect(EMAIL_REDIRECT_TO ?? 'student@example.com').toBe('student@example.com');
  });

  it('still honours a real redirect address, trimmed', () => {
    expect(schema.parse({ EMAIL_REDIRECT_TO: ' qa@example.com ' }).EMAIL_REDIRECT_TO).toBe(
      'qa@example.com',
    );
  });

  it('leaves a missing key undefined', () => {
    expect(schema.parse({}).EMAIL_REDIRECT_TO).toBeUndefined();
  });
});
