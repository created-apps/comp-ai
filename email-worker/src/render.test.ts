import { describe, expect, it } from 'vitest';
import { fill, MissingVariablesError, render } from './render.js';
import { FLOW1, FLOW2, TOF_REPORT } from './templates/index.js';

const FULL = {
  'Student Name': 'Arshiya',
  'Parent Name': 'Ms Mehta',
  'Project Name': 'Impact Forecast Platform',
  'Competition 1': 'IRIS',
  'Why it fits 1': 'because A',
  'Competition 2': 'Conrad',
  'Why it fits 2': 'because B',
  'Competition 3': 'CREST',
  'Why it fits 3': 'because C',
};

describe('placeholder substitution', () => {
  it('falls back from Student/Parent Name to a real name', () => {
    expect(fill('Hi {{Student/Parent Name}},', { 'Parent Name': 'Ms Mehta' }).out).toBe(
      'Hi Ms Mehta,',
    );
    expect(fill('Hi {{Student/Parent Name}},', { 'Student Name': 'Arshiya' }).out).toBe(
      'Hi Arshiya,',
    );
    // and never ships a raw placeholder when neither is known
    expect(fill('Hi {{Student/Parent Name}},', {}).out).toBe('Hi there,');
  });

  it('reports unknown placeholders instead of leaving them in the copy', () => {
    const { out, missing } = fill('Take {{Project Name}} further', {});
    expect(out).not.toContain('{{');
    expect(missing).toContain('Project Name');
  });
});

describe('rendering', () => {
  it('produces matching html and text parts', () => {
    const rendered = render(FLOW2[4]!, FULL);
    expect(rendered.subject).toBe(
      'Opportunities we think are worth considering for Impact Forecast Platform',
    );
    for (const part of [rendered.html, rendered.text]) {
      expect(part).toContain('IRIS');
      expect(part).toContain('because C');
      expect(part).not.toContain('{{');
    }
  });

  it('escapes html so a competition name cannot inject markup', () => {
    const rendered = render(FLOW2[4]!, { ...FULL, 'Competition 1': '<script>x</script>' });
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });

  // The whole reason the picks table exists: this email is meaningless without
  // three competitions, and half-merged copy must never reach a family.
  it('refuses to render the targets email with missing picks', () => {
    const { 'Competition 3': _c3, 'Why it fits 3': _w3, ...incomplete } = FULL;
    expect(() => render(FLOW2[4]!, incomplete)).toThrow(MissingVariablesError);
    try {
      render(FLOW2[4]!, incomplete);
    } catch (err) {
      expect((err as MissingVariablesError).missing).toContain('Competition 3');
    }
  });

  it('renders every template in both flows with sample data', () => {
    for (const [journey, flow] of [
      ['TOF_NURTURE_8', FLOW1],
      ['ENROLLED_EXTENSION_5', FLOW2],
    ] as const) {
      for (const [step, template] of Object.entries(flow)) {
        const rendered = render(template, FULL);
        expect(rendered.subject.length, `${journey} ${step} subject`).toBeGreaterThan(5);
        expect(rendered.html, `${journey} ${step} html`).not.toContain('{{');
        expect(rendered.text, `${journey} ${step} text`).not.toContain('{{');
        expect(rendered.text).toContain('create-ed.in');
      }
    }
  });

  it('renders a variable-length report, stopping at the first gap', () => {
    const five = render(TOF_REPORT, {
      'Student Name': 'Arshiya',
      'Competition 1': 'IRIS',
      'Why it fits 1': 'reason one',
      'Competition 2': 'Conrad',
      'Why it fits 2': 'reason two',
      'Competition 3': 'CREST',
      'Why it fits 3': 'reason three',
    });
    for (const part of [five.html, five.text]) {
      expect(part).toContain('IRIS');
      expect(part).toContain('reason three');
      expect(part).not.toContain('{{');
    }
    // Nothing was supplied for slot 4, so no empty heading is emitted.
    expect(five.text).not.toMatch(/Competition 4/i);
  });

  it('refuses to send a report with no competitions at all', () => {
    expect(() => render(TOF_REPORT, { 'Student Name': 'Arshiya' })).toThrow(
      MissingVariablesError,
    );
  });

  it('covers all 8 + 5 steps with no gaps', () => {
    expect(Object.keys(FLOW1).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Object.keys(FLOW2).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});
