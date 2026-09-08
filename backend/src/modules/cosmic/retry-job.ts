/**
 * Drains the assignment queue.
 *
 * Most of what sits in this queue is not broken — it is waiting. A kid whose
 * COSMIC project has not been created yet is the common case, and it resolves
 * itself the day someone sets that project up. So WAITING_FOR_* rows retry
 * indefinitely, while a genuine failure gives up after COSMIC_MAX_ATTEMPTS and
 * stays visible in the internal console rather than retrying forever.
 *
 * Same shape as the roster scheduler: guarded by an env flag so exactly one
 * deployment owns it, and overlap-guarded so a slow COSMIC cannot stack runs.
 */

import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../../lib/config.js';
import { prisma } from '../../lib/prisma.js';
import { cosmicConfigured } from './client.js';
import { pushAssignment, type PushOutcome } from './assign.js';

export interface DrainSummary {
  attempted: number;
  sent: number;
  waiting: number;
  failed: number;
}

export async function drainAssignmentQueue(limit = config.COSMIC_RETRY_BATCH_LIMIT): Promise<DrainSummary> {
  const pending = await prisma.competitionAssignment.findMany({
    where: {
      OR: [
        { status: 'READY' },
        { status: 'WAITING_FOR_STUDENT' },
        { status: 'WAITING_FOR_PROJECT' },
        // A transport failure is worth retrying, but not forever.
        { status: 'FAILED', attempts: { lt: config.COSMIC_MAX_ATTEMPTS } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true },
  });

  const outcomes: PushOutcome[] = [];
  for (const { id } of pending) {
    outcomes.push(
      await pushAssignment(prisma, id).catch((err: unknown) => ({
        assignmentId: id,
        status: 'FAILED' as const,
        detail: err instanceof Error ? err.message : 'push failed',
      })),
    );
  }

  return {
    attempted: outcomes.length,
    sent: outcomes.filter((o) => o.status === 'SENT').length,
    waiting: outcomes.filter((o) => o.status.startsWith('WAITING')).length,
    failed: outcomes.filter((o) => o.status === 'FAILED').length,
  };
}

export function startCosmicRetryScheduler(log: FastifyBaseLogger): (() => void) | null {
  if (!config.COSMIC_PUSH_ENABLED) {
    log.info('COSMIC assignment push disabled (COSMIC_PUSH_ENABLED=false)');
    return null;
  }
  if (!cosmicConfigured()) {
    log.warn(
      'COSMIC push enabled but COSMIC_API_URL / COSMIC_SERVICE_EMAIL / COSMIC_SERVICE_PASSWORD are missing — not scheduling',
    );
    return null;
  }
  if (!cron.validate(config.COSMIC_RETRY_CRON)) {
    log.error({ cron: config.COSMIC_RETRY_CRON }, 'COSMIC_RETRY_CRON is not a valid expression');
    return null;
  }

  let running = false;

  const task = cron.schedule(config.COSMIC_RETRY_CRON, () => {
    if (running) {
      log.warn('COSMIC assignment drain still running from the previous tick, skipping');
      return;
    }
    running = true;
    drainAssignmentQueue()
      .then((summary) => {
        if (summary.attempted > 0) log.info(summary, 'COSMIC assignment queue drained');
      })
      .catch((err: unknown) => log.error({ err }, 'COSMIC assignment drain failed'))
      .finally(() => {
        running = false;
      });
  });

  log.info({ cron: config.COSMIC_RETRY_CRON }, 'COSMIC assignment retry scheduled');
  return () => task.stop();
}
