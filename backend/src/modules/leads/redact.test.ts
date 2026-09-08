import { describe, expect, it } from 'vitest';
import { redactForLockedLead } from './redact.js';

const payload = {
  region: 'India',
  items: [
    { rank: 1, fitBucket: 'SAFETY', pinned: true, reason: 'free sample', competition: { name: 'Crest Awards', slug: 'crest-awards--in' } },
    { rank: 2, fitBucket: 'TARGET', pinned: false, reason: 'because A', competition: { name: 'IRIS', slug: 'iris--in' } },
    { rank: 3, fitBucket: 'REACH', pinned: false, reason: 'because B', competition: { name: 'ISEF', slug: 'isef--us' } },
  ],
};

describe('lead-gate redaction', () => {
  it('keeps the pinned free sample intact', () => {
    const { payload: out } = redactForLockedLead(payload);
    const first = (out as typeof payload).items[0]!;
    expect(first.competition?.name).toBe('Crest Awards');
  });

  // The point of doing this server-side: nothing identifying may be in the body.
  it('leaves no name, slug or reason for a locked match', () => {
    const { payload: out, lockedCount } = redactForLockedLead(payload);
    expect(lockedCount).toBe(2);

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('IRIS');
    expect(serialized).not.toContain('ISEF');
    expect(serialized).not.toContain('iris--in');
    expect(serialized).not.toContain('because A');

    // but the shape survives, so the UI can say how many are waiting
    expect(serialized).toContain('"locked":true');
    expect((out as { items: { fitBucket: string }[] }).items[1]?.fitBucket).toBe('TARGET');
  });

  it('falls back to the top-ranked item when there is no pin', () => {
    const noPin = { items: payload.items.map((i) => ({ ...i, pinned: false })) };
    const { payload: out, lockedCount } = redactForLockedLead(noPin);
    // A region without CREST still gets one usable free result, not a fully
    // locked page.
    expect((out as typeof noPin).items[0]?.competition?.name).toBe('Crest Awards');
    expect(lockedCount).toBe(2);
  });

  it('handles an empty or malformed payload without throwing', () => {
    expect(redactForLockedLead({ items: [] }).lockedCount).toBe(0);
    expect(redactForLockedLead(null).lockedCount).toBe(0);
  });
});
