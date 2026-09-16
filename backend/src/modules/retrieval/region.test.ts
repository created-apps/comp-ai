import { describe, expect, it } from 'vitest';
import { regionForCountry } from './chroma.js';

/**
 * Signup stores exactly one of 'US' | 'India'. These must map to the region tags
 * the ingest wrote, or a student silently gets zero results.
 */
describe('country → retrieval region', () => {
  it('maps both signup values', () => {
    expect(regionForCountry('India')).toBe('India');
    expect(regionForCountry('US')).toBe('USA');
  });

  it('still tolerates values no longer offered at signup', () => {
    // Accounts created before the question was narrowed to two options, and
    // roster rows written by hand, can still carry this. Null means no region
    // filter — the whole repository rather than an empty slice of it.
    expect(regionForCountry('Others')).toBeNull();
  });

  it('tolerates the looser values the roster sheet may carry', () => {
    expect(regionForCountry('  india ')).toBe('India');
    expect(regionForCountry('United States')).toBe('USA');
    expect(regionForCountry('usa')).toBe('USA');
  });

  it('returns null rather than guessing for anything else', () => {
    expect(regionForCountry('Singapore')).toBeNull();
    expect(regionForCountry(null)).toBeNull();
    expect(regionForCountry(undefined)).toBeNull();
  });
});
