import { describe, expect, it } from 'vitest';
import { loadServiceAccount } from './google-sheets.js';

const VALID = {
  type: 'service_account',
  client_email: 'roster@project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n',
};

const b64 = (value: unknown) =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');

describe('loadServiceAccount', () => {
  it('decodes a base64 service account key', () => {
    const account = loadServiceAccount(b64(VALID));
    expect(account.client_email).toBe(VALID.client_email);
    // the PEM survives base64 with its newlines intact — the whole point of
    // encoding it rather than pasting raw JSON into an env var
    expect(account.private_key).toContain('\n');
    expect(account.private_key).toContain('BEGIN PRIVATE KEY');
  });

  it('tolerates surrounding whitespace and newlines from a shell paste', () => {
    expect(() => loadServiceAccount(`  ${b64(VALID)}\n`)).not.toThrow();
  });

  it('says so when raw JSON was pasted instead of base64', () => {
    expect(() => loadServiceAccount(JSON.stringify(VALID))).toThrow(/base64-encoded/);
  });

  it('rejects an OAuth client key that has no private_key', () => {
    expect(() => loadServiceAccount(b64({ client_id: 'x', client_secret: 'y' }))).toThrow(
      /client_email or private_key/,
    );
  });

  it('rejects a private_key that is not a PEM block', () => {
    expect(() =>
      loadServiceAccount(b64({ ...VALID, private_key: 'not-a-pem' })),
    ).toThrow(/PEM block/);
  });

  it('rejects base64 that does not decode to JSON', () => {
    expect(() => loadServiceAccount(b64('just some text'))).toThrow(/base64-encoded/);
  });

  it('reports a missing value rather than throwing a parse error', () => {
    expect(() => loadServiceAccount('')).toThrow(/is not set/);
  });
});
