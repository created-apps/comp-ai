/**
 * The 5-hourly roster sync.
 *
 * Runs in-process, guarded by ROSTER_SYNC_ENABLED so exactly one deployment owns
 * it — two instances syncing the same sheet would race on persona upgrades. If
 * you scale the API horizontally, leave this off and run `npm run roster:sync`
 * from a real cron or scheduled job instead.
 */

import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../lib/config.js';
import { syncRosterFromSheet } from './sync-sheet.js';

export function startRosterScheduler(log: FastifyBaseLogger): (() => void) | null {
  if (!config.ROSTER_SYNC_ENABLED) {
    log.info('roster sync scheduler disabled (ROSTER_SYNC_ENABLED=false)');
    return null;
  }
  if (!config.GOOGLE_SERVICE_ACCOUNT_JSON || !config.ROSTER_SHEET_ID) {
    log.warn(
      'roster sync enabled but GOOGLE_SERVICE_ACCOUNT_JSON / ROSTER_SHEET_ID are missing — not scheduling',
    );
    return null;
  }
  if (!cron.validate(config.ROSTER_SYNC_CRON)) {
    log.error({ cron: config.ROSTER_SYNC_CRON }, 'ROSTER_SYNC_CRON is not a valid expression');
    return null;
  }

  let running = false;

  const task = cron.schedule(config.ROSTER_SYNC_CRON, () => {
    // A slow sheet read must not let two runs overlap.
    if (running) {
      log.warn('roster sync still running from the previous tick, skipping');
      return;
    }
    running = true;

    void syncRosterFromSheet()
      .then((result) => {
        log.info(
          {
            status: result.status,
            rows: result.rowsSeen,
            added: result.added,
            updated: result.updated,
            deactivated: result.deactivated,
            personaUpgrades: result.personaUpgrades,
            flaggedForReview: result.flaggedForReview.length,
          },
          'roster sync complete',
        );
        if (result.flaggedForReview.length > 0) {
          // Not an error — deliberate. These need a human in /admin.
          log.warn(
            { emails: result.flaggedForReview.slice(0, 20) },
            'enrolled users missing from the sheet — flagged, not downgraded',
          );
        }
      })
      // A failed sync leaves the last-known-good roster in place; the next tick retries.
      .catch((err: unknown) => log.error({ err }, 'roster sync failed'))
      .finally(() => {
        running = false;
      });
  });

  log.info({ cron: config.ROSTER_SYNC_CRON }, 'roster sync scheduled');
  return () => task.stop();
}
