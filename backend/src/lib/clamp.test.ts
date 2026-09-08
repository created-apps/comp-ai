import { describe, expect, it } from 'vitest';
import { clampList, clampNumber, clampText } from './clamp.js';

describe('clampText', () => {
  it('leaves text within the limit untouched', () => {
    expect(clampText('A short reason.', 320)).toBe('A short reason.');
  });

  it('prefers to end on a sentence boundary', () => {
    const text = 'This fits your forecasting model. It also rewards commercial framing in depth.';
    const out = clampText(text, 45);
    expect(out).toBe('This fits your forecasting model.');
    expect(out).not.toContain('…');
  });

  it('falls back to a word boundary rather than cutting mid-word', () => {
    const out = clampText('supercalifragilistic expialidocious antidisestablishmentarianism', 40);
    expect(out).toBe('supercalifragilistic expialidocious…');
    // the truncated word is dropped entirely, not left as a fragment
    expect(out).not.toContain('antidis');
  });

  it('strips a dangling comma before the ellipsis', () => {
    expect(clampText('one two three four five, six seven', 24)).not.toContain(',…');
  });

  it('trims surrounding whitespace', () => {
    expect(clampText('  padded  ', 320)).toBe('padded');
  });
});

describe('clampNumber', () => {
  it('constrains a score the model overshot', () => {
    expect(clampNumber(105, 0, 100)).toBe(100);
    expect(clampNumber(-3, 0, 100)).toBe(0);
    expect(clampNumber(87, 0, 100)).toBe(87);
  });

  it('does not propagate NaN into a stored score', () => {
    expect(clampNumber(Number.NaN, 0, 100)).toBe(0);
  });
});

describe('clampList', () => {
  it('caps length and drops empties', () => {
    expect(clampList([' a ', '', 'b', 'c'], 2)).toEqual(['a', 'b']);
  });
});
