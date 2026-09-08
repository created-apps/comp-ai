/**
 * Google Sheets access for the enrolled-students roster.
 *
 * Credentials arrive as GOOGLE_SERVICE_ACCOUNT_JSON: the service account JSON
 * key, base64-encoded. Base64 rather than raw JSON because the private key is a
 * PEM block full of newlines — pasting it raw into an env var mangles it into
 * literal "\n" and every signature then fails with an unhelpful error.
 *
 * No googleapis dependency: a service account only needs a signed JWT exchanged
 * for an access token, which is one RS256 signature (jsonwebtoken, already a
 * dependency) plus two fetches.
 */

import jwt from 'jsonwebtoken';
import { config } from '../../lib/config.js';
import type { RosterRow } from './sync.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/**
 * Decode and validate the credential. Every failure here is a configuration
 * mistake, so each one says exactly what is wrong rather than surfacing a JSON
 * parse error three layers down.
 */
export function loadServiceAccount(encoded?: string): ServiceAccount {
  const raw = encoded ?? config.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  }

  let json: string;
  try {
    json = Buffer.from(raw.trim(), 'base64').toString('utf8');
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid base64');
  }

  // A common mistake is pasting the raw JSON instead of base64. Decoding that
  // yields bytes that are not JSON, so say which of the two happened.
  if (!json.trimStart().startsWith('{')) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON did not decode to JSON — is it base64-encoded? ' +
        '(base64 -i service-account.json | tr -d "\\n")',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON decoded to invalid JSON');
  }

  const account = parsed as Partial<ServiceAccount>;
  if (!account.client_email || !account.private_key) {
    throw new Error(
      'service account JSON is missing client_email or private_key — is this a service account key, not an OAuth client?',
    );
  }
  if (!account.private_key.includes('BEGIN PRIVATE KEY')) {
    throw new Error('service account private_key does not look like a PEM block');
  }

  return account as ServiceAccount;
}

/** Mint a short-lived access token from the service account. */
export async function getAccessToken(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: account.client_email,
      scope: SCOPE,
      aud: account.token_uri ?? TOKEN_URL,
      iat: now,
      exp: now + 3600,
    },
    account.private_key,
    { algorithm: 'RS256' },
  );

  const response = await fetch(account.token_uri ?? TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Google token exchange failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error('Google token exchange returned no access_token');
  return body.access_token;
}

/**
 * Read the roster tab as rows keyed by header.
 *
 * Uses UNFORMATTED_VALUE so a phone number or a graduation year comes back as
 * typed rather than as Sheets' display formatting.
 */
export async function fetchRosterRows(opts?: {
  sheetId?: string;
  tab?: string;
}): Promise<RosterRow[]> {
  const sheetId = opts?.sheetId ?? config.ROSTER_SHEET_ID;
  const tab = opts?.tab ?? config.ROSTER_SHEET_TAB;

  if (!sheetId) throw new Error('ROSTER_SHEET_ID is not set');

  const account = loadServiceAccount();
  const token = await getAccessToken(account);

  const range = encodeURIComponent(tab);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`;

  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (response.status === 403) {
    throw new Error(
      `Google denied access to the sheet. Share it with ${account.client_email} (Viewer is enough).`,
    );
  }
  if (response.status === 404) {
    throw new Error(`Sheet ${sheetId} or tab "${tab}" not found.`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Sheets API failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  const body = (await response.json()) as { values?: unknown[][] };
  const values = body.values ?? [];
  if (values.length === 0) return [];

  const header = (values[0] ?? []).map((cell) => String(cell ?? '').trim());

  // Sheets omits trailing empty cells, so rows are often shorter than the header.
  return values
    .slice(1)
    .filter((row) => row.some((cell) => String(cell ?? '').trim()))
    .map(
      (row) =>
        Object.fromEntries(
          header.map((name, i) => [name, String(row[i] ?? '').trim()]),
        ) as RosterRow,
    );
}
