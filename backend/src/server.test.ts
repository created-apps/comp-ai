import { describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

// Profile capture (name, phone, grade, school, city, country) moved to the lead
// gate — see modules/leads. Signup deliberately asks for as little as possible.

/**
 * Bodyless POSTs are a real shape in this API (logout, refresh). Fastify's
 * default parser 400s on them, which silently broke session restore.
 */
describe('empty JSON body handling', () => {
  it('accepts a bodyless POST that declares application/json', async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it('still rejects genuinely malformed JSON', async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('still parses a real JSON body', async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ password: 'definitely-wrong' }),
    });
    // 401 not 400: the body parsed, the password was simply wrong.
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
