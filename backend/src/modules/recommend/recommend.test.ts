import { describe, expect, it } from 'vitest';
import type { Competition } from '@prisma/client';
import { checkEligibility, partitionEligible } from './eligibility.js';
import { applyPolicy } from './policy.js';
import { resolvePins } from './pipeline.js';
import { fallbackPinFor, PIN_FALLBACKS } from './pin-fallback.js';
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

describe('pin resolution', () => {
  type PinRow = {
    slug: string;
    baseSlug: string;
    name: string;
    region: string;
    cycleActive: boolean;
    current: boolean;
  };

  type PinWhere = {
    OR: (
      | { baseSlug: string }
      | { baseSlug: { startsWith: string } }
      | { name: { contains: string; mode: 'insensitive' } }
    )[];
  };

  /**
   * Just enough of the client for resolvePins. It has to emulate the OR the
   * real query builds — equals / startsWith / case-insensitive contains —
   * because over-returning rows here would hide a bug in the specificity
   * ranking rather than expose it.
   */
  function fakePrisma(rows: PinRow[]) {
    return {
      competition: {
        findMany: async ({ where }: { where: PinWhere }) =>
          rows.filter((row) =>
            where.OR.some((clause) => {
              if ('name' in clause) {
                return row.name.toLowerCase().includes(clause.name.contains.toLowerCase());
              }
              if (typeof clause.baseSlug === 'string') return row.baseSlug === clause.baseSlug;
              return row.baseSlug.startsWith(clause.baseSlug.startsWith);
            }),
          ),
      },
    } as unknown as Parameters<typeof resolvePins>[0];
  }

  /** resolvePins returns match provenance too; most assertions only want slugs. */
  const slugs = (pins: Awaited<ReturnType<typeof resolvePins>>) => pins.map((p) => p.slug);

  const crestIn: PinRow = {
    slug: 'crest-awards--in',
    baseSlug: 'crest-awards',
    name: 'CREST Awards',
    region: 'India',
    cycleActive: true,
    current: true,
  };
  const crestUs: PinRow = {
    slug: 'crest-awards--us',
    baseSlug: 'crest-awards',
    name: 'CREST Awards',
    region: 'USA',
    cycleActive: true,
    current: true,
  };

  it('prefers the student’s own region', async () => {
    const pins = slugs(await resolvePins(fakePrisma([crestIn, crestUs]), ['crest-awards'], 'USA'));
    expect(pins).toEqual(['crest-awards--us']);
  });

  it('falls back to the other region rather than dropping the pin', async () => {
    // The whole point of the pin is that CREST is the first card every TOF
    // student sees. A US student with only the India row on file gets that row,
    // not a page with no free sample and nothing explaining its absence.
    const pins = slugs(await resolvePins(fakePrisma([crestIn]), ['crest-awards'], 'USA'));
    expect(pins).toEqual(['crest-awards--in']);
  });

  it('falls back to a closed cycle rather than dropping the pin', async () => {
    const pins = slugs(await resolvePins(
      fakePrisma([{ ...crestIn, cycleActive: false }]),
      ['crest-awards'],
      'India',
    ));
    expect(pins).toEqual(['crest-awards--in']);
  });

  it('prefers a current listing over a stale one in the same region', async () => {
    const pins = slugs(await resolvePins(
      fakePrisma([
        { ...crestIn, slug: 'crest-awards--in-old', current: false },
        { ...crestIn, slug: 'crest-awards--in-new', current: true },
      ]),
      ['crest-awards'],
      'India',
    ));
    expect(pins).toEqual(['crest-awards--in-new']);
  });

  it('keeps a non-current pin rather than dropping the free sample', async () => {
    // `current` gates ranked candidates outright, but a pin is a product
    // promise: CREST is the first card on every public report. A stale flag on
    // that one row must not empty the top of the page.
    const pins = slugs(await resolvePins(
      fakePrisma([{ ...crestIn, current: false }]),
      ['crest-awards'],
      'India',
    ));
    expect(pins).toEqual(['crest-awards--in']);
  });

  it('ranks the student’s region above a current listing elsewhere', async () => {
    const pins = slugs(await resolvePins(
      fakePrisma([
        { ...crestIn, current: false },
        { ...crestUs, current: true },
      ]),
      ['crest-awards'],
      'India',
    ));
    expect(pins).toEqual(['crest-awards--in']);
  });

  it('prefers an open cycle in-region over a closed one', async () => {
    const pins = slugs(await resolvePins(
      fakePrisma([{ ...crestIn, slug: 'crest-awards--in-old', cycleActive: false }, crestIn]),
      ['crest-awards'],
      'India',
    ));
    expect(pins).toEqual(['crest-awards--in']);
  });

  it('resolves one row per base slug, never both regions', async () => {
    // A student with no country on file used to pin India *and* US, and saw the
    // same award twice at the top of their report.
    const pins = slugs(await resolvePins(fakePrisma([crestIn, crestUs]), ['crest-awards'], null));
    expect(pins).toHaveLength(1);
  });

  // The pin is configured as `crest-awards`, which is slugify("CREST Awards").
  // The masterlist is a human-edited spreadsheet, so the name it actually
  // carries is not guaranteed to slugify to that — and a pin that only matches
  // one exact spelling fails silently on a rename nobody thought of as a code
  // change. These three are the renames that would otherwise drop the free
  // sample off the top of every public report.
  it('matches a suffixed listing: "CREST Awards (Gold)"', async () => {
    const pins = slugs(
      await resolvePins(
        fakePrisma([
          {
            ...crestIn,
            slug: 'crest-awards-gold--in',
            baseSlug: 'crest-awards-gold',
            name: 'CREST Awards (Gold)',
          },
        ]),
        ['crest-awards'],
        'India',
      ),
    );
    expect(pins).toEqual(['crest-awards-gold--in']);
  });

  it('matches on name when the slug does not line up at all', async () => {
    const pins = slugs(
      await resolvePins(
        fakePrisma([
          {
            ...crestIn,
            slug: 'the-crest-award-scheme--in',
            baseSlug: 'the-crest-award-scheme',
            name: 'The CREST Award Scheme',
          },
        ]),
        ['crest-awards'],
        'India',
      ),
    );
    expect(pins).toEqual(['the-crest-award-scheme--in']);
  });

  it('prefers an exact slug over a looser name match, even out of region', async () => {
    // Specificity beats quality: the wrong competition first is worse than the
    // right one in the wrong region.
    const pins = slugs(
      await resolvePins(
        fakePrisma([
          {
            ...crestIn,
            slug: 'crest-fellowship--in',
            baseSlug: 'crest-fellowship',
            name: 'CREST Research Fellowship',
          },
          crestUs,
        ]),
        ['crest-awards'],
        'India',
      ),
    );
    expect(pins).toEqual(['crest-awards--us']);
  });

  it('reports how loosely each pin matched', async () => {
    const [pin] = await resolvePins(
      fakePrisma([
        { ...crestIn, slug: 'x--in', baseSlug: 'crest-awards-gold', name: 'CREST Awards Gold' },
      ]),
      ['crest-awards'],
      'India',
    );
    expect(pin?.matchedBy).toBe('prefix');
    expect(pin?.name).toBe('CREST Awards Gold');
  });

  it('resolves nothing when the competition is not in the repository at all', async () => {
    expect(await resolvePins(fakePrisma([]), ['crest-awards'], 'India')).toEqual([]);
  });

  // ...and that is exactly when the built-in card takes over, so the student
  // still leads with CREST. This is the floor under the whole guarantee.
  it('has a built-in card for every pin the TOF policy configures', () => {
    for (const base of policyFor('TOF').pinnedCompetitionSlugs) {
      expect(fallbackPinFor(base), `no fallback for pinned "${base}"`).toBeDefined();
    }
  });

  it('the built-in card is shaped like a real public competition', () => {
    const crest = fallbackPinFor('crest-awards');
    expect(crest?.slug).toBe('crest-awards');
    expect(crest?.name).toBe('CREST Awards');
    expect(crest?.deadline.isRolling).toBe(true);
    expect(crest?.officialUrl).toMatch(/^https:\/\//);
  });

  it('the built-in card asserts no score it cannot back up', () => {
    // The reranker's governing rule is never to claim what the data does not
    // say. A hard-coded card is the one place that rule could be quietly
    // broken, so it is asserted here instead.
    const crest = fallbackPinFor('crest-awards');
    expect(crest?.prestige).toBeNull();
    expect(crest?.selectivity).toBeNull();
    expect(crest?.difficulty).toBeNull();
    expect(crest?.eligibility).toBeNull();
  });

  it('the built-in card carries no internal fields', () => {
    // It bypasses toPublicDto — that serializer is the security seam, so a
    // hand-written card has to satisfy the same allowlist by construction.
    for (const card of Object.values(PIN_FALLBACKS)) {
      for (const leaked of ['notes', 'comments', 'winnerLists', 'internalGuidanceUrl']) {
        expect(card, `${card.slug} leaks ${leaked}`).not.toHaveProperty(leaked);
      }
    }
  });

  it('the built-in slug cannot collide with an ingested row', () => {
    // Ingested slugs are always region-qualified ("crest-awards--in"), so a
    // bare base slug is safe as the fallback's id.
    for (const slug of Object.keys(PIN_FALLBACKS)) {
      expect(slug).not.toContain('--');
    }
  });

  // The end the user actually cares about: with an empty repository, a TOF
  // report still leads with CREST and that first card renders as a real
  // competition rather than an empty shell.
  it('leads with CREST even when the repository has no CREST row', async () => {
    const policy = policyFor('TOF');
    const ranked: RankedItem[] = [
      { slug: 'iris--in', score: 90, reason: 'a real match', fitBucket: 'TARGET' },
    ];

    // Step 5 as the pipeline runs it: nothing resolves, so the pin falls back.
    const resolved = await resolvePins(fakePrisma([]), policy.pinnedCompetitionSlugs, 'India');
    expect(resolved).toEqual([]);

    const pinnedSlugs = policy.pinnedCompetitionSlugs.flatMap((base) =>
      fallbackPinFor(base) ? [base] : [],
    );
    const { items } = applyPolicy({ ranked, policy, pinnedSlugs });

    expect(items[0]?.slug).toBe('crest-awards');
    expect(items[0]?.pinned).toBe(true);
    // Never scored, so the UI must not print a fit percentage for it.
    expect(items[0]?.ranked).toBe(false);
    expect(items[1]?.slug).toBe('iris--in');

    // Step 6: the card the student sees is populated, not null.
    const card = fallbackPinFor(items[0]!.slug);
    expect(card?.name).toBe('CREST Awards');
  });

  it('does not query at all for a persona with no pins', async () => {
    expect(await resolvePins(fakePrisma([crestIn]), [], 'India')).toEqual([]);
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

  it('reports a pin that resolved to no document at all', () => {
    // resolvePins now widens across region and cycle before giving up, so an
    // empty pinnedSlugs means CREST is absent from the repository entirely —
    // a seeding problem, and the trace has to say so.
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
