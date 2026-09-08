import { describe, expect, it } from 'vitest';
import { normalizeEmail, policyFor, POLICIES } from './persona.js';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  John.Doe@Example.com ')).toBe('john.doe@example.com');
  });

  it('strips +tags on any provider', () => {
    expect(normalizeEmail('parent+kid@example.com')).toBe('parent@example.com');
  });

  it('ignores dots only where the provider does', () => {
    // gmail treats dots as insignificant, so these are one person
    expect(normalizeEmail('john.doe+iris@gmail.com')).toBe('johndoe@gmail.com');
    expect(normalizeEmail('johndoe@gmail.com')).toBe('johndoe@gmail.com');
    // elsewhere they are meaningful and must not be collapsed
    expect(normalizeEmail('john.doe@create-ed.in')).toBe('john.doe@create-ed.in');
  });

  it('does not mangle malformed input', () => {
    expect(normalizeEmail('not-an-email')).toBe('not-an-email');
    expect(normalizeEmail('')).toBe('');
  });
});

describe('persona policy', () => {
  it('never exposes internal fields or web search to TOF', () => {
    const tof = policyFor('TOF');
    expect(tof.exposesInternalFields).toBe(false);
    expect(tof.allowsWebVerification).toBe(false);
    expect(tof.chatKnowledgeScope).toBe('PUBLIC');
  });

  it('caps TOF results at 8 and requires no approval', () => {
    expect(policyFor('TOF').maxResults).toBeLessThanOrEqual(8);
    expect(policyFor('TOF').requiresInternalApproval).toBe(false);
  });

  it('requires internal approval for enrolled recommendations', () => {
    expect(policyFor('ENROLLED').requiresInternalApproval).toBe(true);
    expect(policyFor('ENROLLED').entitlementDriven).toBe(true);
  });

  it('pins CREST as the free sample for TOF only', () => {
    expect(policyFor('TOF').pinnedCompetitionSlugs).toContain('crest-awards');
    expect(policyFor('ENROLLED').pinnedCompetitionSlugs).toHaveLength(0);
  });

  it('caps TOF chat exposure so a session cannot enumerate the repository', () => {
    const tof = policyFor('TOF');
    expect(tof.chatTurnLimit).not.toBeNull();
    expect(tof.chatCompetitionExposureCap).not.toBeNull();
    expect(tof.chatCompetitionExposureCap!).toBeLessThanOrEqual(tof.maxResults);
  });

  it('covers every persona', () => {
    expect(Object.keys(POLICIES).sort()).toEqual(['ENROLLED', 'TOF']);
  });
});
