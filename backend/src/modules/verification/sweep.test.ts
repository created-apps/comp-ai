import { describe, expect, it } from 'vitest';
import { rankCandidates, type CandidateSets } from './sweep.js';

const c = (id: string) => ({ id, name: id.toUpperCase() });

const sets = (overrides: Partial<CandidateSets> = {}): CandidateSets => ({
  activated: [],
  delivered: [],
  deadlineSoon: [],
  neverVerified: [],
  stale: [],
  ...overrides,
});

/**
 * A sweep that verifies everything equally would spend most of its budget on
 * competitions nobody has been shown. The order here is the whole point: what a
 * student is holding, then what a family has been sent, then what closes soon.
 */
describe('rankCandidates', () => {
  it('verifies what students hold before anything else', () => {
    const batch = rankCandidates(
      sets({
        stale: [c('stale-1')],
        neverVerified: [c('never-1')],
        activated: [c('held-1')],
        delivered: [c('sent-1')],
        deadlineSoon: [c('soon-1')],
      }),
      { limit: 5 },
    );

    expect(batch.map((b) => b.id)).toEqual(['held-1', 'sent-1', 'soon-1', 'never-1', 'stale-1']);
  });

  it('lists a competition once, under its most urgent reason', () => {
    const batch = rankCandidates(
      sets({
        activated: [c('x')],
        delivered: [c('x')],
        neverVerified: [c('x')],
      }),
      { limit: 5 },
    );

    expect(batch).toHaveLength(1);
    expect(batch[0]!.reason).toBe('ACTIVATED');
  });

  // The cap is what bounds the cost of a tick — each candidate is a multi-turn
  // web search, not a database read.
  it('never exceeds the batch limit', () => {
    const batch = rankCandidates(
      sets({ neverVerified: [c('a'), c('b'), c('c'), c('d')] }),
      { limit: 2 },
    );

    expect(batch).toHaveLength(2);
  });

  it('honours the limit even when the urgent tier alone overflows it', () => {
    const batch = rankCandidates(
      sets({ activated: [c('a'), c('b'), c('c')], deadlineSoon: [c('d')] }),
      { limit: 2 },
    );

    expect(batch.map((b) => b.id)).toEqual(['a', 'b']);
  });

  // Re-running a competition whose proposal is already in the queue files a
  // second identical diff for the same reviewer.
  it('skips excluded competitions — recently checked, or awaiting review', () => {
    const batch = rankCandidates(
      sets({ activated: [c('pending'), c('fresh')], neverVerified: [c('new')] }),
      { limit: 5, excludeIds: ['pending'] },
    );

    expect(batch.map((b) => b.id)).toEqual(['fresh', 'new']);
  });

  it('marks a closing deadline as the pre-milestone trigger, not a routine check', () => {
    const batch = rankCandidates(sets({ deadlineSoon: [c('closing')] }), { limit: 5 });

    expect(batch[0]!.trigger).toBe('PRE_MILESTONE');
  });

  it('returns nothing when there is nothing to do', () => {
    expect(rankCandidates(sets(), { limit: 5 })).toEqual([]);
  });
});
