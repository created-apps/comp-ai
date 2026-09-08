import { describe, expect, it } from 'vitest';
import { parseRosterRows, type RosterRow } from './sync.js';

/** The real programme sheet header set. */
function row(over: Partial<RosterRow> = {}): RosterRow {
  return {
    'Student Name': 'Arshiya Mehta',
    'Student Email': 'Arshiya.Mehta@Gmail.com',
    'Parent Name': 'Ms Mehta',
    'Parent Email': 'parent@example.com',
    'School Name': 'DPS',
    'Program Type(s)': 'RBP, Competition Mastery',
    'Program Track': 'Engineering',
    'Project Name': 'Construction Impact Forecast Platform',
    'Project Description': 'A forecasting platform for construction impact on city air quality.',
    'Parent Name2': 'Mr Mehta',
    'Parent Email2': 'parent2@example.com',
    ...over,
  };
}

describe('roster parsing', () => {
  it('picks up student name, parent name and project details', () => {
    const { entries } = parseRosterRows([row()]);
    const entry = entries[0]!;
    expect(entry.studentName).toBe('Arshiya Mehta');
    expect(entry.parentName).toBe('Ms Mehta');
    expect(entry.projectName).toBe('Construction Impact Forecast Platform');
    expect(entry.projectDescription).toContain('forecasting platform');
    expect(entry.programTypes).toEqual(['RBP', 'Competition Mastery']);
  });

  it('normalises the student email and keeps both parent addresses', () => {
    const { entries } = parseRosterRows([row()]);
    const entry = entries[0]!;
    // gmail dots are insignificant, so the roster stores the canonical form
    expect(entry.emailNormalized).toBe('arshiyamehta@gmail.com');
    expect(entry.parentEmailNormalized).toBe('parent@example.com');
    expect(entry.parentEmail2Normalized).toBe('parent2@example.com');
  });

  it('falls back to Parent Name2 when the first parent name is blank', () => {
    const { entries } = parseRosterRows([row({ 'Parent Name': '' })]);
    expect(entries[0]!.parentName).toBe('Mr Mehta');
  });

  it('leaves project fields null when the sheet has none', () => {
    const { entries } = parseRosterRows([
      row({ 'Project Name': '', 'Project Description': '' }),
    ]);
    expect(entries[0]!.projectName).toBeNull();
    expect(entries[0]!.projectDescription).toBeNull();
  });

  it('uses a parent address when the student has none', () => {
    const { entries } = parseRosterRows([row({ 'Student Email': '' })]);
    expect(entries[0]!.emailNormalized).toBe('parent@example.com');
  });

  it('records rows it cannot use rather than dropping them silently', () => {
    const { entries, skipped } = parseRosterRows([
      row({ 'Student Email': '', 'Parent Email': '', 'Parent Email2': '' }),
    ]);
    expect(entries).toHaveLength(0);
    expect(skipped[0]).toContain('no valid email');
  });

  it('deduplicates two rows for the same family', () => {
    const { entries, skipped } = parseRosterRows([row(), row({ 'Student Email': 'arshiyamehta@gmail.com' })]);
    expect(entries).toHaveLength(1);
    expect(skipped[0]).toContain('duplicate');
  });

  it('tolerates header casing and spacing drift', () => {
    const { entries } = parseRosterRows([
      { 'student email': 'a@b.com', 'project name': 'X', ' Student Name ': 'A' } as RosterRow,
    ]);
    expect(entries[0]!.projectName).toBe('X');
  });
});
