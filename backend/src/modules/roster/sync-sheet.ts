/**
 * Pull the enrolled roster from Google Sheets and sync it.
 *
 *   npm run roster:sync
 *
 * Same `syncRoster` the CSV importer uses, so the guards apply identically: a
 * shrunken sheet is refused rather than wiping the roster, and enrolled users
 * missing from the export are flagged for review instead of downgraded.
 */

import { prisma } from '../../lib/prisma.js';
import { fetchRosterRows } from './google-sheets.js';
import { syncRoster, type SyncResult } from './sync.js';

export async function syncRosterFromSheet(): Promise<SyncResult> {
  const rows = await fetchRosterRows();
  return syncRoster(prisma, rows);
}

export function formatSyncResult(result: SyncResult): string {
  const lines = [
    `sync ${result.status} (run ${result.syncRunId})`,
    `  roster rows:      ${result.rowsSeen}`,
    `  added:            ${result.added}`,
    `  updated:          ${result.updated}`,
    `  deactivated:      ${result.deactivated}`,
    `  persona upgrades: ${result.personaUpgrades}`,
    `  profiles updated: ${result.profilesUpdated}`,
    `  projects synced:  ${result.projectsUpserted}`,
    `  flow 2 started:   ${result.journeysStarted} (were waiting on a project name)`,
  ];
  if (result.missingProjectName.length > 0) {
    lines.push(
      '',
      `  ${result.missingProjectName.length} roster rows have no Project Name.`,
      '  They cannot produce competition picks, so the Day 9 email will not fire:',
      ...result.missingProjectName
        .slice(0, 10)
        .map((r) => `    · ${r.studentName ?? '(no name)'} <${r.email}>`),
    );
  }
  if (result.flaggedForReview.length > 0) {
    lines.push(
      '',
      `  ${result.flaggedForReview.length} enrolled users are no longer on the sheet.`,
      '  They were NOT downgraded — review them in /admin:',
      ...result.flaggedForReview.slice(0, 10).map((e) => `    · ${e}`),
    );
  }
  if (result.skipped.length > 0) {
    lines.push('', `  ${result.skipped.length} rows skipped:`, ...result.skipped.slice(0, 10).map((s) => `    · ${s}`));
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  console.log('Fetching roster from Google Sheets…');
  const result = await syncRosterFromSheet();
  console.log('\n' + formatSyncResult(result));
  if (result.status === 'FAILED') process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}
