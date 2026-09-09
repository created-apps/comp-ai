import { describe, expect, it } from 'vitest';
import { buildServer } from '../../server.js';

/**
 * The confirmation prompt only makes sense for the account it belongs to, so
 * every route here is behind auth. A project is also a piece of programme data
 * about a real family — it must not be readable or mutable by a stranger.
 */
describe('project confirmation endpoints', () => {
  const routes: [string, 'GET' | 'POST'][] = [
    ['/projects/pending-confirmation', 'GET'],
    ['/projects/current', 'GET'],
    ['/projects/abc/confirm', 'POST'],
    ['/projects/abc/dismiss', 'POST'],
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
