/**
 * Render every email to ./preview/ without sending anything.
 *
 *   npm run preview
 *
 * Marketing copy should be reviewable in a browser before it reaches a family.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import type { Journey } from './contract.js';
import { render } from './render.js';
import { FLOW1, FLOW2, INTERNAL_REVIEW_TEMPLATE, TOF_REPORT } from './templates/index.js';

const SAMPLE: Record<string, string> = {
  'Student Name': 'Arshiya',
  'Parent Name': 'Ms Mehta',
  'Project Name': 'Construction Impact Forecast Platform',
  'Competition 1': 'IRIS National Fair',
  'Why it fits 1':
    'Your forecasting model is exactly the kind of evidence-backed engineering IRIS judges reward, and your city data gives it a clear real-world stake.',
  'Competition 2': 'Conrad Challenge',
  'Why it fits 2':
    'Conrad rewards a commercial framing, and your platform already has an identifiable user in municipal planners.',
  'Competition 3': 'Crest Awards',
  'Why it fits 3':
    'A strong accreditation you can enter with the prototype as it stands today, while the larger competitions are still open.',
  'Project Description':
    'A platform that forecasts the air-quality impact of construction sites so city planners can intervene earlier.',
  'Student Context': 'Grade 11 · Dhirubhai Ambani International School · India',
  'Competition Count': '3',
  'Review URL': 'http://localhost:3000/admin/reviews/run_abc123',
};

async function main(): Promise<void> {
  const dir = new URL('../preview/', import.meta.url);
  await mkdir(dir, { recursive: true });

  const flows: [Journey, Record<number, Parameters<typeof render>[0]>][] = [
    // Step 0 is the lead-gate report — outside the drip, but part of the flow.
    ['TOF_NURTURE_8', { 0: TOF_REPORT, ...FLOW1 }],
    ['ENROLLED_EXTENSION_5', FLOW2],
    ['INTERNAL_REVIEW', { 1: INTERNAL_REVIEW_TEMPLATE }],
  ];

  const index: string[] = ['<h1>Competition AI email previews</h1>'];

  for (const [journey, templates] of flows) {
    index.push(`<h2>${journey}</h2><ul>`);
    for (const [step, template] of Object.entries(templates)) {
      const { subject, html } = render(template, SAMPLE);
      const file = `${journey}-${step.padStart(2, '0')}.html`;
      await writeFile(new URL(file, dir), html, 'utf8');
      index.push(`<li><a href="${file}">Step ${step} — ${subject}</a></li>`);
      console.log(`  ${file}  ${subject}`);
    }
    index.push('</ul>');
  }

  await writeFile(new URL('index.html', dir), index.join('\n'), 'utf8');
  console.log(`\nOpen email-worker/preview/index.html`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
