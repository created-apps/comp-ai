import { describe, expect, it } from 'vitest';
import { Job } from 'bullmq';
import { emailJobId, safeJobId } from './contract.js';

/**
 * BullMQ throws "Custom Id cannot contain :" at enqueue time, which surfaces as
 * a 500 on a user-facing request — a signup or a lead unlock — rather than a bad
 * row somewhere. These ids are built in several places, so the rule is pinned here.
 */
describe('email job ids', () => {
  it('never contains a colon', () => {
    expect(emailJobId('TOF_NURTURE_8', 1, 'a@b.com')).not.toContain(':');
    expect(emailJobId('ENROLLED_EXTENSION_5', 4, 'Parent+Kid@Example.COM')).not.toContain(':');
  });

  it('is stable and lower-cased, so a repeat enqueue dedupes', () => {
    expect(emailJobId('TOF_NURTURE_8', 1, ' A@B.com ')).toBe(
      emailJobId('TOF_NURTURE_8', 1, 'a@b.com'),
    );
  });

  it('separates parts unambiguously', () => {
    // journeys use single underscores, so "__" cannot collide with one
    expect(emailJobId('TOF_NURTURE_8', 3, 'a-b@c.com')).toBe('TOF_NURTURE_8__3__a-b@c.com');
  });

  it('distinguishes steps and journeys', () => {
    const a = emailJobId('TOF_NURTURE_8', 1, 'x@y.com');
    const b = emailJobId('TOF_NURTURE_8', 2, 'x@y.com');
    const c = emailJobId('ENROLLED_EXTENSION_5', 1, 'x@y.com');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('strips colons from a hand-built id', () => {
    expect(safeJobId('TOF_REPORT:resend:a@b.com:123')).not.toContain(':');
  });

  /**
   * Checked against BullMQ's own validator rather than against our reading of
   * its rules — this is the exact function that threw in production, and it
   * needs no Redis connection to run.
   */
  it('passes BullMQ validateOptions for every id we generate', () => {
    const validate = (Job.prototype as unknown as Record<string, unknown>)['validateOptions'];
    expect(typeof validate).toBe('function');

    const ids = [
      emailJobId('TOF_NURTURE_8', 1, 'Arshiya.Mehta+school@Gmail.com'),
      emailJobId('ENROLLED_EXTENSION_5', 4, 'parent@example.co.in'),
      safeJobId('TOF_REPORT__a@b.com'),
      safeJobId(`TOF_REPORT-resend__a@b.com__${Date.now()}`),
      // the shapes that used to throw
      safeJobId('TOF_NURTURE_8:1:a@b.com'),
      safeJobId('TOF_REPORT:resend:a@b.com:123'),
    ];

    for (const jobId of ids) {
      expect(() =>
        (validate as (this: unknown, opts: unknown) => void).call({ opts: { jobId } }, { jobId }),
      ).not.toThrow();
    }
  });
});
