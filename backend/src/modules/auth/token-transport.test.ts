import { describe, expect, it } from 'vitest';
import { buildServer } from '../../server.js';
import { config } from '../../lib/config.js';

/**
 * The front end and the API are on different domains (Vercel and Railway), so
 * nothing may depend on a cookie surviving the round trip. These tests pin the
 * transport itself: tokens go out in the body, come back in the Authorization
 * header, and no response ever sets a cookie.
 */
describe('token transport', () => {
  it('sets no cookie on any auth response', async () => {
    const app = await buildServer();

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@example.com', password: 'not-the-password' },
    });
    const logout = await app.inject({ method: 'POST', url: '/auth/logout' });

    expect(login.headers['set-cookie']).toBeUndefined();
    expect(logout.headers['set-cookie']).toBeUndefined();
    expect(logout.statusCode).toBe(200);
    await app.close();
  });

  it('refuses a refresh with no token at all', async () => {
    const app = await buildServer();
    const response = await app.inject({ method: 'POST', url: '/auth/refresh' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('no refresh token');
    await app.close();
  });

  it('reads the refresh token from the body', async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: 'not-a-real-token' },
    });

    // It got as far as verifying, which is the point — the body was read.
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('invalid refresh token');
    await app.close();
  });

  /**
   * The client's request helper puts the *access* token on this header for every
   * call. If the header were preferred, a refresh carrying a valid token in its
   * body would be judged on the stale header value and 401 a live session.
   */
  it('prefers the body over a stale access token in the header', async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { authorization: 'Bearer stale-access-token' },
      payload: { refreshToken: 'not-a-real-token' },
    });

    expect(response.json().error).toBe('invalid refresh token');
    await app.close();
  });
});

describe('admin token transport', () => {
  it('returns a bearer token instead of setting a cookie, and accepts it back', async () => {
    const app = await buildServer();

    const login = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: { password: config.ADMIN_PASSWORD },
    });

    expect(login.statusCode).toBe(200);
    expect(login.headers['set-cookie']).toBeUndefined();
    const { token } = login.json();
    expect(typeof token).toBe('string');

    const session = await app.inject({
      method: 'GET',
      url: '/admin/session',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(session.statusCode).toBe(200);
    await app.close();
  });

  it('refuses a request with no token, and one with a token it did not sign', async () => {
    const app = await buildServer();

    const missing = await app.inject({ method: 'GET', url: '/admin/session' });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error).toBe('admin login required');

    const forged = await app.inject({
      method: 'GET',
      url: '/admin/session',
      headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.not-a-signature' },
    });
    expect(forged.statusCode).toBe(401);
    await app.close();
  });

  /**
   * Both credentials arrive in the same header, so the admin surface must reject
   * a normal user's access token rather than treating any signed token as admin.
   */
  it('refuses a user access token on the admin surface', async () => {
    const { signAccessToken } = await import('./jwt.js');
    const app = await buildServer();

    const userToken = signAccessToken({
      sub: 'user-1',
      role: 'STUDENT',
      persona: 'TOF',
      ver: 0,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/admin/session',
      headers: { authorization: `Bearer ${userToken}` },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
