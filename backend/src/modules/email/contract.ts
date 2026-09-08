/**
 * The email queue contract.
 *
 * This file is duplicated verbatim in email-worker/src/contract.ts. The two
 * services are deployed independently and share no package, so the contract is
 * copied rather than imported — but it must stay identical. Change one, change
 * the other, and bump CONTRACT_VERSION so a mismatched worker is obvious in the
 * logs instead of silently dropping fields.
 */

export const CONTRACT_VERSION = 1;

/** BullMQ queue name. Must match on both sides or nothing is ever delivered. */
export const EMAIL_QUEUE = 'emails';

export type Journey =
  | 'TOF_NURTURE_8'
  | 'ENROLLED_EXTENSION_5'
  /** Internal: a recommendation set is waiting for a human to approve it. */
  | 'INTERNAL_REVIEW';

export interface EmailJob {
  contractVersion: number;
  journey: Journey;
  /** 1-based position within the journey. */
  step: number;
  to: string;
  toName?: string;
  /**
   * Merge values for the template: 'Student Name', 'Project Name',
   * 'Competition 1', 'Why it fits 1', … Keys match the {{...}} placeholders in
   * the approved email copy, so the copy can be pasted in unchanged.
   */
  variables: Record<string, string>;
  /** Stable identity for this send; used as the BullMQ jobId to dedupe. */
  idempotencyKey: string;
}

/**
 * BullMQ rejects a custom job id containing ":" — it is Redis's key separator.
 * "__" is safe and cannot collide: journey names use single underscores, steps
 * are numbers, and an email address contains neither.
 */
const ID_SEPARATOR = '__';

export function emailJobId(journey: string, step: number, email: string): string {
  return safeJobId(`${journey}${ID_SEPARATOR}${step}${ID_SEPARATOR}${email.trim().toLowerCase()}`);
}

/**
 * Last line of defence for any hand-built id. BullMQ throws at enqueue time, so
 * a stray colon becomes a 500 on a user-facing request rather than a bad row.
 */
export function safeJobId(value: string): string {
  return value.replaceAll(':', '-');
}
