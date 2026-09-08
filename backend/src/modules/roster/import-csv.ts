/**
 * Import the enrolled-students roster from a CSV export of the Google Sheet.
 *
 *   npm run roster:import -- "../data/Master Sheet subsheet - Sheet1.csv"
 *
 * The 5-hourly cron will call `syncRoster` with rows from the Sheets API; this
 * CLI feeds it the same rows from a file, so the import path is identical and
 * the roster can be loaded today without service-account credentials.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prisma } from '../../lib/prisma.js';
import { syncRoster, type RosterRow } from './sync.js';

/** Minimal RFC4180 reader — the sheet has quoted commas and newlines in cells. */
function parseCsv(text: string): RosterRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += ch;
  }
  if (cell || row.length > 0) { row.push(cell); rows.push(row); }

  const header = rows.shift();
  if (!header) return [];

  return rows
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])) as RosterRow);
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) throw new Error('usage: npm run roster:import -- <path-to-roster.csv>');

  const path = resolve(process.cwd(), arg);
  const rows = parseCsv(await readFile(path, 'utf8'));
  console.log(`Read ${rows.length} rows from ${path}`);

  const result = await syncRoster(prisma, rows);

  console.log(`\nsync ${result.status} (run ${result.syncRunId})`);
  console.log(`  roster rows:      ${result.rowsSeen}`);
  console.log(`  added:            ${result.added}`);
  console.log(`  updated:          ${result.updated}`);
  console.log(`  deactivated:      ${result.deactivated}`);
  console.log(`  persona upgrades: ${result.personaUpgrades}`);
  console.log(`  profiles updated: ${result.profilesUpdated}`);
  console.log(`  projects synced:  ${result.projectsUpserted}`);
  console.log(`  flow 2 started:   ${result.journeysStarted} (were waiting on a project name)`);

  if (result.missingProjectName.length > 0) {
    console.log(`\n  ${result.missingProjectName.length} rows have no Project Name.`);
    console.log('  These students cannot get competition picks or the Day 9 email:');
    for (const r of result.missingProjectName.slice(0, 10)) {
      console.log(`    · ${r.studentName ?? '(no name)'} <${r.email}>`);
    }
  }

  if (result.flaggedForReview.length > 0) {
    console.log(`\n  ${result.flaggedForReview.length} enrolled users are no longer on the sheet.`);
    console.log('  They were NOT downgraded — review them in /admin:');
    for (const email of result.flaggedForReview.slice(0, 10)) console.log(`    · ${email}`);
  }
  if (result.skipped.length > 0) {
    console.log(`\n  ${result.skipped.length} rows skipped:`);
    for (const s of result.skipped.slice(0, 10)) console.log(`    · ${s}`);
  }
  if (result.status === 'FAILED') {
    console.log('\n  Roster left untouched. Check the export before retrying.');
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
