import jwt from 'jsonwebtoken';
import { config } from '../../lib/config.js';
import type { Persona } from '../../lib/persona.js';

export interface AccessClaims {
  sub: string;
  role: string;
  /**
   * A hint only. The roster sync can flip a persona between logins, so every
   * request re-reads it from the database — the claim exists for logging and
   * for cheap client-side rendering, never for authorization.
   */
  persona: Persona;
  /** Bumped on the user to invalidate all outstanding tokens. */
  ver: number;
}

export interface RefreshClaims {
  sub: string;
  ver: number;
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, config.JWT_ACCESS_SECRET, {
    expiresIn: config.JWT_ACCESS_TTL,
  } as jwt.SignOptions);
}

export function signRefreshToken(claims: RefreshClaims): string {
  return jwt.sign(claims, config.JWT_REFRESH_SECRET, {
    expiresIn: config.JWT_REFRESH_TTL,
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessClaims {
  return jwt.verify(token, config.JWT_ACCESS_SECRET) as AccessClaims;
}

export function verifyRefreshToken(token: string): RefreshClaims {
  return jwt.verify(token, config.JWT_REFRESH_SECRET) as RefreshClaims;
}
