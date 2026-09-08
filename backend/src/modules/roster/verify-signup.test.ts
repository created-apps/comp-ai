import { beforeEach, describe, expect, it } from 'vitest';
import { clearSheetCache, findInEntries, primeSheetCache } from './verify-signup.js';
import { parseRosterRows, type RosterRow } from './sync.js';

const SHEET: RosterRow[] = [
  {
    'Student Name': 'Arshiya Mehta',
    'Student Email': 'Arshiya.Mehta@Gmail.com',
    'Parent Name': 'Ms Mehta',
    'Parent Email': 'parent@example.com',
    'Parent Email2': 'parent2@example.com',
    'Project Name': 'Impact Forecast Platform',
  },
];

describe('live signup verification', () => {
  beforeEach(() => clearSheetCache());

  it('matches on the student address, normalising as the roster does', () => {
    const { entries } = parseRosterRows(SHEET);
    // gmail dots and +tags must not cause a paying family to be missed
    expect(findInEntries(entries, 'arshiyamehta@gmail.com')?.studentName).toBe('Arshiya Mehta');
    expect(findInEntries(entries, 'Arshiya.Mehta+school@GMAIL.com')?.studentName).toBe(
      'Arshiya Mehta',
    );
  });

  it('matches on either parent address — parents sign up too', () => {
    const { entries } = parseRosterRows(SHEET);
    expect(findInEntries(entries, 'parent@example.com')).not.toBeNull();
    expect(findInEntries(entries, 'PARENT2@example.com ')).not.toBeNull();
  });

  it('returns null for someone genuinely not on the sheet', () => {
    const { entries } = parseRosterRows(SHEET);
    expect(findInEntries(entries, 'stranger@example.com')).toBeNull();
  });

  it('caches parsed rows so a burst of signups does not refetch the sheet', () => {
    primeSheetCache(SHEET);
    const { entries } = parseRosterRows(SHEET);
    expect(entries).toHaveLength(1);
    // The cache holds parsed entries, so lookups are pure in-memory matching.
    expect(findInEntries(entries, 'parent@example.com')).not.toBeNull();
  });
});
