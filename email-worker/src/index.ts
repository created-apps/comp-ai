/**
 * Email worker.
 *
 * Subscribes to the Redis-backed `emails` queue that the backend publishes to,
 * renders the approved copy, and sends through SendGrid.
 *
 * Deployed and scaled independently of the API: mail delivery should never be in
 * the request path of a signup, and a SendGrid outage should queue work rather
 * than fail user-facing calls.
 */

import { Worker, UnrecoverableError, type Job } from 'bullmq';
import { config } from './config.js';
import { CONTRACT_VERSION, EMAIL_QUEUE, type EmailJob } from './contract.js';
import { MissingVariablesError, render } from './render.js';
import { PermanentSendError, send } from './sendgrid.js';
import { getTemplate } from './templates/index.js';

function redisConnection() {
  const url = new URL(config.REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password ? { password: url.password } : {}),
  };
}

async function handle(job: Job<EmailJob>): Promise<unknown> {
  const { journey, step, to, toName, variables, contractVersion } = job.data;

  // A worker running older code than the publisher would silently drop new
  // fields. Fail loudly instead so a bad deploy is visible immediately.
  if (contractVersion !== CONTRACT_VERSION) {
    throw new UnrecoverableError(
      `contract mismatch: job v${contractVersion}, worker v${CONTRACT_VERSION} — redeploy the worker`,
    );
  }

  const template = getTemplate(journey, step);
  if (!template) {
    throw new UnrecoverableError(`no template for ${journey} step ${step}`);
  }

  let rendered;
  try {
    rendered = render(template, variables);
  } catch (err) {
    if (err instanceof MissingVariablesError) {
      // Retrying will not conjure the variables. Half-merged copy must never
      // reach a family, so this fails permanently and stays on the failed list.
      throw new UnrecoverableError(`${journey} step ${step} for ${to}: ${err.message}`);
    }
    throw err;
  }

  try {
    const result = await send(to, toName, rendered);
    return { ...result, subject: rendered.subject };
  } catch (err) {
    if (err instanceof PermanentSendError) throw new UnrecoverableError(err.message);
    throw err;
  }
}

const worker = new Worker<EmailJob>(EMAIL_QUEUE, handle, {
  connection: redisConnection(),
  concurrency: config.WORKER_CONCURRENCY,
});

worker.on('completed', (job, result: unknown) => {
  const r = result as { delivered?: boolean; skipped?: string };
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      event: r?.delivered ? 'sent' : 'skipped',
      jobId: job.id,
      journey: job.data.journey,
      step: job.data.step,
      to: job.data.to,
      ...(r?.skipped ? { reason: r.skipped } : {}),
    }),
  );
});

worker.on('failed', (job, err) => {
  console.error(
    JSON.stringify({
      at: new Date().toISOString(),
      event: 'failed',
      jobId: job?.id,
      journey: job?.data.journey,
      step: job?.data.step,
      to: job?.data.to,
      attempt: job?.attemptsMade,
      error: err.message,
    }),
  );
});

console.log(
  `email worker listening on "${EMAIL_QUEUE}" · concurrency ${config.WORKER_CONCURRENCY} · ` +
    `sending ${config.EMAIL_SEND_ENABLED ? 'ENABLED' : 'DISABLED'}` +
    (config.EMAIL_REDIRECT_TO ? ` · redirecting all mail to ${config.EMAIL_REDIRECT_TO}` : ''),
);

// Finish in-flight sends before exiting, so a deploy cannot drop a message
// mid-delivery and leave it looking complete.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, closing worker…`);
    void worker.close().then(() => process.exit(0));
  });
}
