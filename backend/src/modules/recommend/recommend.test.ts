import { describe, expect, it } from 'vitest';
import type { Competition } from '@prisma/client';
import { checkEligibility, partitionEligible } from './eligibility.js';
import { applyPolicy } from './policy.js';
import { policyFor } from '../../lib/persona.js';
import type { RankedItem } from './rerank.js';

const NOW = new Date('2026-09-07T00:00:00Z');

function comp(over: Partial<Competition> = {}): Competition {
  return {
    id: 'c1',
    slug: 'iris--in',
    baseSlug: 'iris',
    name: 'IRIS',
    region: 'India',
    regionCode: 'IN',
    regions: ['IN'],
    sourceSheets: ['india.csv'],
    description: 'A science fair.',
    submissionDetails: null,
    domains: ['science'],
    domainsRaw: 'Science',
    deadlineDate: new Date('2026-12-01T00:00:00Z'),
    deadlineMonth: 12,
    deadlineYear: 2026,
    deadlineText: '1 December 2026',
    deadlinePrecision: 'DAY',
    isRolling: false,
    gradeMin: 9,
    gradeMax: 12,
    ageMin: null,
    ageMax: null,
    eligibilityRaw: 'Grades 9-12',
    allowsIndividual: true,
    allowsTeam: true,
    teamMin: 1,
    teamMax: 3,
    teamRaw: 'Individual or team of up to 3',
    registrationStatus: 'OPEN',
    registrationText: 'Open',
    prestige: 5,
    selectivity: 4,
    complexity: null,
    timeInvestment: null,
    totalScore: null,
    difficulty: 'HARD',
    officialUrls: ['https://iris.example'],
    cycle: '2026',
    cycleActive: true,
    winnerLists: null,
    notes: null,
    comments: null,
    internalGuidanceUrl: null,
    contentHash: null,
    lastVerifiedAt: null,
    verifiedById: null,
    sourceRows: null,
    warnings: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as Competition;
}

describe('hard eligibility', () => {
  it('accepts a student inside every stated bound', () => {
    const result = checkEligibility(comp(), { grade: 10, teamSize: 2, region: 'India', now: NOW });
    expect(result.eligible).toBe(true);
    expect(result.rejections).toHaveLength(0);
  });

  it('rejects on grade, age, team size and region', () => {
    const codes = (c: Partial<Competition>, s: Parameters<typeof checkEligibility>[1]) =>
      checkEligibility(comp(c), { ...s, now: NOW }).rejections.map((r) => r.code);

    expect(codes({}, { grade: 7 })).toContain('GRADE_BELOW_MIN');
    expect(codes({}, { grade: 13 })).toContain('GRADE_ABOVE_MAX');
    expect(codes({ ageMin: 14 }, { age: 12 })).toContain('AGE_BELOW_MIN');
    expect(codes({}, { teamSize: 5 })).toContain('TEAM_TOO_LARGE');
    expect(codes({ allowsIndividual: false }, { teamSize: 1 })).toContain('SOLO_NOT_ALLOWED');
    expect(codes({ allowsTeam: false }, { teamSize: 3 })).toContain('TEAM_NOT_ALLOWED');
    expect(codes({}, { region: 'USA' })).toContain('REGION_MISMATCH');
    expect(codes({ cycleActive: false }, {})).toContain('CYCLE_INACTIVE');
  });

  // The masterlist is full of blanks. Treating missing data as a failed check
  // would delete most of the repository from every result set.
  it('never rejects on data the sheet does not have', () => {
    const blank = comp({
      gradeMin: null,
      gradeMax: null,
      ageMin: null,
      ageMax: null,
      teamMin: null,
      teamMax: null,
      allowsIndividual: null,
      allowsTeam: null,
      deadlineDate: null,
      deadlinePrecision: 'UNKNOWN',
      domains: [],
    });
    const result = checkEligibility(blank, { grade: 10, age: 15, teamSize: 4, now: NOW });
    expect(result.eligible).toBe(true);
    // but it says so, so the reason can't imply eligibility was verified
    expect(result.unverified.join(' ')).toMatch(/grade range|deadline/);
  });

  it('only retires a competition on a full-precision past date', () => {
    const past = comp({ deadlineDate: new Date('2026-01-01T00:00:00Z') });
    expect(checkEligibility(past, { now: NOW }).eligible).toBe(false);

    // "March 2026" must not be dropped mid-month on a guessed day
    const monthOnly = comp({
      deadlineDate: new Date('2026-01-01T00:00:00Z'),
      deadlinePrecision: 'MONTH',
    });
    expect(checkEligibility(monthOnly, { now: NOW }).eligible).toBe(true);

    const rolling = comp({ deadlineDate: null, isRolling: true, deadlinePrecision: 'ROLLING' });
    expect(checkEligibility(rolling, { now: NOW }).eligible).toBe(true);
  });

  // The "STEM Best Practice Summits and Awards" case: a masterlist row with
  // nothing but a name. Its embedded document is near-noise, so it surfaces
  // against almost any query, and the reranker can only caveat it.
  it('rejects a row that carries nothing but a name', () => {
    const empty = comp({
      description: null,
      submissionDetails: null,
      domains: [],
      eligibilityRaw: null,
      deadlineDate: null,
      deadlinePrecision: 'UNKNOWN',
    });
    const result = checkEligibility(empty, { grade: 11, now: NOW });
    expect(result.eligible).toBe(false);
    expect(result.rejections.map((r) => r.code)).toContain('NO_CONTENT');
  });

  it('keeps a row that has a description but no domain', () => {
    // 109 of 237 competitions have no Subject/Domain. A description is enough
    // to justify a recommendation, so those must survive.
    const noDomain = comp({ domains: [], domainsRaw: null });
    expect(checkEligibility(noDomain, { grade: 11, now: NOW }).eligible).toBe(true);
  });

  it('keeps a row that has only submission details', () => {
    const onlySubmission = comp({ description: null, domains: [], submissionDetails: 'Submit a report.' });
    expect(checkEligibility(onlySubmission, { grade: 11, now: NOW }).eligible).toBe(true);
  });

  it('partitions and keeps the rejection reason', () => {
    const { eligible, dropped } = partitionEligible(
      [comp(), comp({ id: 'c2', slug: 'x--in', gradeMin: 11 })],
      { grade: 10, now: NOW },
    );
    expect(eligible).toHaveLength(1);
    expect(dropped[0]?.rejections[0]?.code).toBe('GRADE_BELOW_MIN');
  });
});

describe('persona policy application', () => {
  const ranked: RankedItem[] = Array.from({ length: 12 }, (_, i) => ({
    slug: `comp-${i}--in`,
    score: 90 - i,
    reason: `reason ${i}`,
    fitBucket: 'TARGET' as const,
  }));

  it('pins CREST first for TOF even when it was not ranked', () => {
    const { items } = applyPolicy({
      ranked,
      policy: policyFor('TOF'),
      pinnedSlugs: ['crest-awards--in'],
    });
    expect(items[0]?.slug).toBe('crest-awards--in');
    expect(items[0]?.pinned).toBe(true);
    // Marked unranked so nothing downstream renders its placeholder score as a
    // real "0% fit" verdict on the free sample.
    expect(items[0]?.ranked).toBe(false);
  });

  it('marks a pin as ranked when the model did score it', () => {
    const withCrest: RankedItem[] = [
      { slug: 'crest-awards--in', score: 61, reason: 'specific', fitBucket: 'SAFETY' },
      ...ranked,
    ];
    const { items } = applyPolicy({
      ranked: withCrest,
      policy: policyFor('TOF'),
      pinnedSlugs: ['crest-awards--in'],
    });
    expect(items[0]?.ranked).toBe(true);
    expect(items[0]?.score).toBe(61);
  });

  it('keeps the model reason when a pinned competition was also ranked', () => {
    const withCrest: RankedItem[] = [
      { slug: 'crest-awards--in', score: 55, reason: 'specific to this project', fitBucket: 'SAFETY' },
      ...ranked,
    ];
    const { items } = applyPolicy({
      ranked: withCrest,
      policy: policyFor('TOF'),
      pinnedSlugs: ['crest-awards--in'],
    });
    expect(items[0]?.reason).toBe('specific to this project');
    // and it is not duplicated further down the list
    expect(items.filter((i) => i.slug === 'crest-awards--in')).toHaveLength(1);
  });

  it('caps TOF at 8 including the pin, and enrolled at 5', () => {
    const tof = applyPolicy({ ranked, policy: policyFor('TOF'), pinnedSlugs: ['crest-awards--in'] });
    expect(tof.items).toHaveLength(8);

    const enrolled = applyPolicy({ ranked, policy: policyFor('ENROLLED'), pinnedSlugs: [] });
    expect(enrolled.items).toHaveLength(5);
    expect(enrolled.items.every((i) => !i.pinned)).toBe(true);
  });

  it('reports a pin that has no document in the student’s region', () => {
    // CREST only exists in the India sheet, so a US TOF user gets no pin.
    const { items, unresolvedPins } = applyPolicy({
      ranked,
      policy: policyFor('TOF'),
      pinnedSlugs: [],
    });
    expect(unresolvedPins).toContain('crest-awards');
    expect(items[0]?.pinned).toBe(false);
  });

  it('returns fewer results rather than padding', () => {
    const { items } = applyPolicy({
      ranked: ranked.slice(0, 2),
      policy: policyFor('ENROLLED'),
      pinnedSlugs: [],
    });
    expect(items).toHaveLength(2);
  });
});
