/**
 * CLI + scheduler for the verification sweep.
 *
 *   npm run verify:sweep              # one batch, now
 *   npm run verify:sweep -- --limit 3
 *
 * Guarded by VERIFICATION_ENABLED so exactly one deployment owns it: two
 * instances sweeping at once would spend twice the search budget and file
 * duplicate proposals into the same review queue.
 */

import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../lib/config.js';
import { prisma } from '../../lib/prisma.js';
import { runVerificationSweep, type SweepOptions } from './sweep.js';

export function sweepOptions(overrides: Partial<SweepOptions> = {}): SweepOptions {
  return {
    limit: config.VERIFICATION_BATCH_LIMIT,
    staleDays: config.VERIFICATION_STALE_DAYS,
    deadlineWindowDays: config.VERIFICATION_DEADLINE_WINDOW_DAYS,
    cooldownHours: config.VERIFICATION_COOLDOWN_HOURS,
    ...overrides,
  };
}

export function startVerificationScheduler(log: FastifyBaseLogger): (() => void) | null {
  if (!config.VERIFICATION_ENABLED) {
    log.info('verification sweep disabled (VERIFICATION_ENABLED=false)');
    return null;
  }
  if (!config.ANTHROPIC_API_KEY) {
    log.warn('verification sweep enabled but ANTHROPIC_API_KEY is missing — not scheduling');
    return null;
  }
  if (!cron.validate(config.VERIFICATION_CRON)) {
    log.error({ cron: config.VERIFICATION_CRON }, 'VERIFICATION_CRON is not a valid expression');
    return null;
  }

  let running = false;

  const task = cron.schedule(config.VERIFICATION_CRON, () => {
    // Each competition is a multi-turn web search. Overlapping ticks would
    // double the spend and re-pick the same rows.
    if (running) {
      log.warn('verification sweep still running from the previous tick, skipping');
      return;
    }
    running = true;
    runVerificationSweep(prisma, sweepOptions())
      .then((summary) => {
        if (summary.attempted === 0) return;
        log.info(
          { attempted: summary.attempted, ...summary.byOutcome },
          'verification sweep complete',
        );
        // A proposal nobody is told about is a proposal nobody applies.
        if (summary.pendingReview > 0) {
          log.warn(
            { pendingReview: summary.pendingReview },
            'verification proposals are waiting for a human — /admin',
          );
        }
      })
      .catch((err: unknown) => log.error({ err }, 'verification sweep failed'))
      .finally(() => {
        running = false;
      });
  });

  log.info(
    { cron: config.VERIFICATION_CRON, batch: config.VERIFICATION_BATCH_LIMIT },
    'verification sweep scheduled',
  );
  return () => task.stop();
}

async function main(): Promise<void> {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : undefined;

  const options = sweepOptions(limit && Number.isFinite(limit) ? { limit } : {});
  console.log(`Verifying up to ${options.limit} competitions against their official sources…\n`);

  const summary = await runVerificationSweep(prisma, options);

  if (summary.attempted === 0) {
    console.log('Nothing to verify: everything in scope was checked recently or is awaiting review.');
  }
  for (const result of summary.results) {
    console.log(`  [${result.reason}] ${result.name}\n      ${result.outcome} — ${result.message}`);
  }
  if (summary.pendingReview > 0) {
    console.log(
      `\n  ${summary.pendingReview} proposal(s) need a human before anything changes: /admin`,
    );
  }

  await prisma.$disconnect();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
