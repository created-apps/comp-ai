/**
 * Email publisher.
 *
 * The backend never talks to SendGrid. It publishes jobs to Redis and the email
 * worker owns delivery — so an outage or rate limit at the provider cannot fail
 * a signup, and the worker can be redeployed without touching the API.
 *
 * BullMQ rather than raw Redis pub/sub: pub/sub drops a message when no
 * subscriber happens to be connected, which for a transactional email means it
 * is simply never sent and nothing anywhere records that. BullMQ persists the
 * job, retries with backoff, and keeps failures on a dead-letter list.
 */

import { Queue } from 'bullmq';
import { config } from '../../lib/config.js';
import { EMAIL_QUEUE, emailJobId, CONTRACT_VERSION, type EmailJob, type Journey } from './contract.js';
import { stepsFor, PICKS_DEPENDENT_STEPS } from './journeys.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let queue: Queue<EmailJob> | null = null;

export function getEmailQueue(): Queue<EmailJob> {
  if (!queue) {
    const url = new URL(config.REDIS_URL);
    queue = new Queue<EmailJob>(EMAIL_QUEUE, {
      connection: {
        host: url.hostname,
        port: Number(url.port || 6379),
        ...(url.password ? { password: url.password } : {}),
      },
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
        // Keep failures around: an undelivered email is something a human needs
        // to see, not something to garbage-collect.
        removeOnFail: false,
      },
    });
  }
  return queue;
}

export async function closeEmailQueue(): Promise<void> {
  await queue?.close();
  queue = null;
}

export interface EnqueueJourneyInput {
  journey: Journey;
  to: string;
  toName?: string;
  variables: Record<string, string>;
  /** Journey start; defaults to now. Day offsets are measured from this. */
  startAt?: Date;
  /** True when the student has three saved competitions to merge. */
  hasPicks?: boolean;
}

export interface EnqueueResult {
  scheduled: { step: number; day: number; runAt: string }[];
  skipped: { step: number; reason: string }[];
}

/**
 * Schedule an entire sequence up front, using BullMQ delays.
 *
 * Delaying jobs rather than running a daily "who is due today" sweep means the
 * schedule survives a backend restart and there is no cron that can silently
 * stop firing. The jobId makes it idempotent: enqueueing the same journey for
 * the same address twice is a no-op, not a duplicate send.
 */
export async function enqueueJourney(input: EnqueueJourneyInput): Promise<EnqueueResult> {
  const q = getEmailQueue();
  const start = input.startAt ?? new Date();
  const scheduled: EnqueueResult['scheduled'] = [];
  const skipped: EnqueueResult['skipped'] = [];

  const picksSteps = PICKS_DEPENDENT_STEPS[input.journey] ?? [];

  for (const step of stepsFor(input.journey)) {
    // The competition-targets email is meaningless without the three picks —
    // sending it with empty placeholders is worse than not sending it.
    if (picksSteps.includes(step.step) && !input.hasPicks) {
      skipped.push({ step: step.step, reason: 'no saved competition picks for this student' });
      continue;
    }

    const runAt = new Date(start.getTime() + step.day * DAY_MS);
    const delay = Math.max(0, runAt.getTime() - Date.now());

    await q.add(
      `${input.journey}:${step.step}`,
      {
        contractVersion: CONTRACT_VERSION,
        journey: input.journey,
        step: step.step,
        to: input.to,
        ...(input.toName ? { toName: input.toName } : {}),
        variables: input.variables,
        idempotencyKey: emailJobId(input.journey, step.step, input.to),
      },
      { jobId: emailJobId(input.journey, step.step, input.to), delay },
    );

    scheduled.push({ step: step.step, day: step.day, runAt: runAt.toISOString() });
  }

  return { scheduled, skipped };
}

/**
 * Enqueue a single step of a journey, positioned on its real day.
 *
 * Used to backfill the picks email: at signup a student has no competitions yet,
 * so step 4 is skipped. When the nightly job saves their three picks, this puts
 * that one email back on the schedule — on Day 9 of their flow if that is still
 * ahead, or immediately if it has already passed.
 */
export async function enqueueStep(input: {
  journey: Journey;
  step: number;
  to: string;
  toName?: string;
  variables: Record<string, string>;
  startAt: Date;
}): Promise<{ runAt: string } | { skipped: string }> {
  const definition = stepsFor(input.journey).find((s) => s.step === input.step);
  if (!definition) return { skipped: `no step ${input.step} in ${input.journey}` };

  const q = getEmailQueue();
  const runAt = new Date(input.startAt.getTime() + definition.day * DAY_MS);
  const delay = Math.max(0, runAt.getTime() - Date.now());

  await q.add(
    `${input.journey}:${input.step}`,
    {
      contractVersion: CONTRACT_VERSION,
      journey: input.journey,
      step: input.step,
      to: input.to,
      ...(input.toName ? { toName: input.toName } : {}),
      variables: input.variables,
      idempotencyKey: emailJobId(input.journey, input.step, input.to),
    },
    { jobId: emailJobId(input.journey, input.step, input.to), delay },
  );

  return { runAt: runAt.toISOString() };
}

/** Send one email immediately — used for the TOF report, which is not a drip. */
export async function enqueueImmediate(
  job: Omit<EmailJob, 'contractVersion' | 'idempotencyKey'> & { idempotencyKey?: string },
): Promise<void> {
  const q = getEmailQueue();
  const id = job.idempotencyKey ?? emailJobId(job.journey, job.step, job.to);
  await q.add(
    `${job.journey}:${job.step}`,
    { ...job, contractVersion: CONTRACT_VERSION, idempotencyKey: id },
    { jobId: id },
  );
}
