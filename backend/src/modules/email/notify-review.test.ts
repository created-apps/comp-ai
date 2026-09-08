import { describe, expect, it } from 'vitest';
import { reviewRecipients } from './notify-review.js';
import { INTERNAL_REVIEW } from './journeys.js';

/**
 * The recipient list comes from an env var typed by hand, so it has to tolerate
 * the ways people actually write one.
 */
describe('review recipients', () => {
  it('is empty when the env var is unset, and notifies nobody', () => {
    // config is loaded with INTERNAL_REVIEW_EMAILS unset in tests
    expect(reviewRecipients()).toEqual([]);
  });
});

describe('the internal review notification', () => {
  it('is a single immediate send, not a drip', () => {
    expect(INTERNAL_REVIEW).toHaveLength(1);
    expect(INTERNAL_REVIEW[0]?.day).toBe(0);
  });
});
