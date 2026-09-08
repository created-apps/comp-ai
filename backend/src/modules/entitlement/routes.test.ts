import { describe, expect, it } from 'vitest';
import { buildServer } from '../../server.js';

/**
 * Entitlement, selection and the resulting workspace are all programme data
 * about a real family. Every route is behind auth, and the ENROLLED-only checks
 * live on the server rather than in the UI — a TOF account must not be able to
 * reach the selection endpoint by pointing a client at it.
 */
describe('selection endpoints', () => {
  const routes: [string, 'GET' | 'POST'][] = [
    ['/entitlement', 'GET'],
    ['/recommendations/abc/select', 'POST'],
    ['/me/competitions', 'GET'],
  ];

  for (const [url, method] of routes) {
    it(`requires authentication: ${method} ${url}`, async () => {
      const app = await buildServer();
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(401);
      await app.close();
    });
  }
});
