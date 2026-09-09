import { describe, expect, it, vi } from 'vitest';

/**
 * The front end is on Vercel and this API on Railway, so every browser call is
 * cross-origin and the preflight is load-bearing. Two failures have already been
 * seen in production and are pinned here:
 *
 *  1. A literal "*" — refused outright by any client whose request is
 *     credentialed, with an error that reads as if the server were broken.
 *  2. The library's default method list, GET,HEAD,POST — the admin console's PUT
 *     and PATCH never reach a route.
 */
async function serverWith(webOrigin: string) {
  vi.resetModules();
  process.env.WEB_ORIGIN = webOrigin;
  const { buildServer } = await import('../../server.js');
  return buildServer();
}

const preflight = (url = '/auth/login', method = 'POST') => ({
  method: 'OPTIONS' as const,
  url,
  headers: {
    origin: 'https://comp-ai-weld.vercel.app',
    'access-control-request-method': method,
    'access-control-request-headers': 'content-type,authorization',
  },
});

describe('CORS preflight', () => {
  it('reflects the caller origin rather than answering with a wildcard', async () => {
    const app = await serverWith('https://comp-ai-weld.vercel.app');
    const response = await app.inject(preflight());

    expect(response.headers['access-control-allow-origin']).toBe(
      'https://comp-ai-weld.vercel.app',
    );
    expect(response.headers['access-control-allow-origin']).not.toBe('*');
    await app.close();
  });

  // "Allow anything" must still not mean the one value a credentialed request
  // rejects — that is the exact production error this replaced.
  it('never emits a wildcard even when WEB_ORIGIN is *', async () => {
    const app = await serverWith('*');
    const response = await app.inject(preflight());

    expect(response.headers['access-control-allow-origin']).toBe(
      'https://comp-ai-weld.vercel.app',
    );
    await app.close();
  });

  it('allows the methods the admin console actually uses', async () => {
    const app = await serverWith('https://comp-ai-weld.vercel.app');
    const allowed = String(
      (await app.inject(preflight('/admin/students/s1/allowance', 'PUT'))).headers[
        'access-control-allow-methods'
      ],
    );

    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(allowed).toContain(method);
    }
    await app.close();
  });

  it('allows the Authorization header — the whole session travels in it', async () => {
    const app = await serverWith('https://comp-ai-weld.vercel.app');
    const response = await app.inject(preflight());

    expect(String(response.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'authorization',
    );
    await app.close();
  });

  it('sends no allow-origin at all for an origin that is not on the list', async () => {
    const app = await serverWith('https://comp-ai-weld.vercel.app');
    const response = await app.inject({
      ...preflight(),
      headers: { ...preflight().headers, origin: 'https://evil.example.com' },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  // Nothing is credentialed any more: tokens ride in a header, not a cookie.
  it('does not claim to support credentials', async () => {
    const app = await serverWith('https://comp-ai-weld.vercel.app');
    const response = await app.inject(preflight());

    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    await app.close();
  });
});
