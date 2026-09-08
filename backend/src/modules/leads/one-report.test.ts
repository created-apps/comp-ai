import { describe, expect, it } from 'vitest';
import { buildServer } from '../../server.js';

/**
 * These assert the shape of the gate at the HTTP boundary. Both endpoints must
 * refuse an unauthenticated caller — the lead form is the one place a stranger
 * could otherwise post arbitrary details and pull a report.
 */
describe('lead gate endpoints', () => {
  it('requires authentication to unlock a report', async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: 'POST',
      url: '/leads/report',
      payload: { runId: 'r1', name: 'A', phone: '12345', grade: 11, school: 'S', city: 'C', country: 'India' },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('requires authentication to read unlock status', async () => {
    const app = await buildServer();
    const response = await app.inject({ method: 'GET', url: '/leads/me' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
