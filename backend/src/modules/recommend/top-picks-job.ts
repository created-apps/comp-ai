/**
 * CLI + scheduler for the top-picks refresh.
 *
 *   npm run picks:refresh            # nightly pass
 *   npm run picks:refresh -- --force # recompute everything
 */

import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../lib/config.js';
import { prisma } from '../../lib/prisma.js';
import { refreshTopPicks } from './top-picks.js';

export function startTopPicksScheduler(log: FastifyBaseLogger): (() => void) | null {
  if (!config.TOP_PICKS_ENABLED) {
    log.info('top-picks scheduler disabled (TOP_PICKS_ENABLED=false)');
    return null;
  }
  if (!cron.validate(config.TOP_PICKS_CRON)) {
    log.error({ cron: config.TOP_PICKS_CRON }, 'TOP_PICKS_CRON is not a valid expression');
    return null;
  }

  let running = false;
  const task = cron.schedule(config.TOP_PICKS_CRON, () => {
    // Each student costs two model calls; overlapping runs would double the bill
    // and race on the same rows.
    if (running) {
      log.warn('top-picks refresh still running, skipping this tick');
      return;
    }
    running = true;
    void refreshTopPicks(prisma, { limit: config.TOP_PICKS_BATCH_LIMIT })
      .then((result) => {
        log.info(result, 'top-picks refresh complete');
        if (result.failed.length > 0) log.warn({ failed: result.failed }, 'some students failed');
      })
      .catch((err: unknown) => log.error({ err }, 'top-picks refresh failed'))
      .finally(() => {
        running = false;
      });
  });

  log.info({ cron: config.TOP_PICKS_CRON }, 'top-picks refresh scheduled');
  return () => task.stop();
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  console.log(`Refreshing enrolled students' top 3 competitions${force ? ' (forced)' : ''}…`);

  const result = await refreshTopPicks(prisma, { force });

  console.log(`\n  considered:        ${result.considered}`);
  console.log(`  generated:         ${result.generated}`);
  console.log(`  skipped (no project): ${result.skippedNoProject}`);
  console.log(`  skipped (still fresh): ${result.skippedFresh}`);
  if (result.thin.length > 0) {
    console.log(`\n  ${result.thin.length} thin results:`);
    for (const t of result.thin.slice(0, 15)) console.log(`    · ${t}`);
  }
  if (result.failed.length > 0) {
    console.log(`\n  ${result.failed.length} failures:`);
    for (const f of result.failed.slice(0, 10)) console.log(`    · ${f.studentId}: ${f.error}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}
