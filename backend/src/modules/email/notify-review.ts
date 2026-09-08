/**
 * Tell the internal team that a recommendation set needs a human.
 *
 * The requirement is that AI output is reviewed before it becomes client-facing.
 * Without a notification that review queue is a page nobody thinks to open, and
 * the student sits on "your matches are with the CreatED team" indefinitely.
 *
 * Recipients come from INTERNAL_REVIEW_EMAILS. Never throws: failing to notify
 * must not fail the generation that produced the recommendations.
 */

import type { PrismaClient } from '@prisma/client';
import { config } from '../../lib/config.js';
import { enqueueImmediate } from './queue.js';
import { safeJobId } from './contract.js';

export function reviewRecipients(): string[] {
  return (config.INTERNAL_REVIEW_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.includes('@'));
}

interface PayloadItem {
  reason?: string;
  competition?: { name?: string } | null;
}

export async function notifyReviewers(
  prisma: PrismaClient,
  runId: string,
): Promise<{ notified: string[]; skipped?: string }> {
  const recipients = reviewRecipients();
  if (recipients.length === 0) {
    return { notified: [], skipped: 'INTERNAL_REVIEW_EMAILS is not set' };
  }

  const run = await prisma.recommendationRun.findUnique({
    where: { id: runId },
    include: {
      project: {
        include: { student: { select: { name: true, grade: true, school: true, country: true } } },
      },
    },
  });
  if (!run) return { notified: [], skipped: 'run not found' };

  const items = ((run.payload as unknown as { items?: PayloadItem[] })?.items ?? []).filter(
    (i) => i.competition?.name,
  );

  const variables: Record<string, string> = {
    'Student Name': run.project.student?.name ?? 'A student',
    'Project Name': run.project.name ?? run.project.description.slice(0, 80),
    'Project Description': run.project.description,
    'Student Context': [
      run.project.student?.grade ? `Grade ${run.project.student.grade}` : null,
      run.project.student?.school,
      run.project.student?.country,
    ]
      .filter(Boolean)
      .join(' · '),
    'Competition Count': String(items.length),
    // Deep link into the admin console. WEB_ORIGIN is the frontend, which is
    // where /admin lives.
    'Review URL': `${config.WEB_ORIGIN.replace(/\/$/, '')}/admin/reviews/${run.id}`,
  };

  items.forEach((item, i) => {
    variables[`Competition ${i + 1}`] = item.competition!.name!;
    variables[`Why it fits ${i + 1}`] = item.reason ?? '';
  });

  const notified: string[] = [];
  for (const to of recipients) {
    try {
      await enqueueImmediate({
        journey: 'INTERNAL_REVIEW',
        step: 1,
        to,
        variables,
        idempotencyKey: safeJobId(`INTERNAL_REVIEW__${run.id}__${to.toLowerCase()}`),
      });
      notified.push(to);
    } catch {
      // One bad address must not stop the others being told.
    }
  }

  return { notified };
}
