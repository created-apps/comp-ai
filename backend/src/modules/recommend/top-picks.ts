/**
 * Nightly job: give every enrolled student three saved competitions and a
 * reason for each, ready to merge into Flow 2 / Email 2.
 *
 * The email copy reads:
 *
 *   {{Competition 1}} / {{Why it fits}}
 *   {{Competition 2}} / {{Why it fits}}
 *   {{Competition 3}} / {{Why it fits}}
 *
 * so the job stores exactly that shape — six flat columns on EnrolledTopPicks —
 * rather than making the mail merge walk a join.
 *
 * Two things it deliberately does NOT do:
 *
 *  - It does not send anything. It fills the table; enqueueing the journey is a
 *    separate step, so a bad run can be corrected before any family sees it.
 *  - It does not overwrite a good set of picks with a worse one. If a re-run
 *    produces fewer than three usable picks, the existing row is left alone.
 */

import type { PrismaClient } from '@prisma/client';
import { enqueueStep } from '../email/queue.js';
import { generateRecommendations } from './pipeline.js';

/** Recompute picks older than this. Competition cycles do not move hourly. */
const STALE_AFTER_DAYS = 14;

/** Flow 2's competition-targets email, the one that merges the three picks. */
const PICKS_EMAIL_STEP = 4;

export interface TopPicksResult {
  considered: number;
  generated: number;
  skippedNoProject: number;
  skippedFresh: number;
  failed: { studentId: string; error: string }[];
  thin: string[];
  /** Day 9 emails put back on the schedule now that picks exist. */
  picksEmailsQueued: number;
}

export interface TopPicksOptions {
  /** Recompute even for students whose picks are still fresh. */
  force?: boolean;
  /** Cap per run, so one nightly pass cannot spend unbounded model budget. */
  limit?: number;
  studentId?: string;
}

export async function refreshTopPicks(
  prisma: PrismaClient,
  opts: TopPicksOptions = {},
): Promise<TopPicksResult> {
  const result: TopPicksResult = {
    considered: 0,
    generated: 0,
    skippedNoProject: 0,
    skippedFresh: 0,
    failed: [],
    thin: [],
    picksEmailsQueued: 0,
  };

  const students = await prisma.student.findMany({
    where: {
      ...(opts.studentId ? { id: opts.studentId } : {}),
      // Enrolled only. A TOF user's picks would be governed by a different
      // policy (8 results, CREST pinned) and belong in the lead report instead.
      user: { persona: 'ENROLLED' },
    },
    include: {
      topPicks: true,
      projects: {
        where: { dismissedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      // Needed as the fallback recipient when no parent address is on file.
      user: { select: { email: true } },
    },
    ...(opts.limit ? { take: opts.limit } : {}),
  });

  const staleBefore = new Date(Date.now() - STALE_AFTER_DAYS * 24 * 3600 * 1000);

  for (const student of students) {
    result.considered++;

    const project = student.projects[0];
    if (!project) {
      result.skippedNoProject++;
      continue;
    }

    if (
      !opts.force &&
      student.topPicks &&
      student.topPicks.competition1 &&
      student.topPicks.generatedAt > staleBefore &&
      student.topPicks.projectId === project.id
    ) {
      result.skippedFresh++;
      continue;
    }

    try {
      // Ask the pipeline for three. Everything else — region scoping, hard
      // eligibility, the id-constrained rerank — is the same path the app uses,
      // so an emailed competition can never be one the student cannot enter.
      const run = await generateRecommendations(prisma, {
        projectId: project.id,
        persona: 'ENROLLED',
        student: {
          grade: student.grade,
          age: student.age,
          country: student.country,
        },
        limit: 3,
      });

      const stored = await prisma.recommendationRun.findUnique({
        where: { id: run.runId },
        select: { payload: true },
      });

      const items =
        (stored?.payload as unknown as { items?: PayloadItem[] } | null)?.items ?? [];

      const picks = items
        .filter((item) => item.competition?.name)
        .slice(0, 3)
        .map((item) => ({
          name: item.competition!.name,
          why: item.reason,
        }));

      if (picks.length === 0) {
        result.thin.push(`${student.name}: pipeline returned no usable picks`);
        continue;
      }

      // A thin result must not replace a complete one — the family would get an
      // email with two of three slots empty.
      const existing = student.topPicks;
      const existingCount = existing
        ? [existing.competition1, existing.competition2, existing.competition3].filter(Boolean)
            .length
        : 0;
      if (picks.length < 3 && existingCount > picks.length) {
        result.thin.push(
          `${student.name}: kept ${existingCount} existing picks over ${picks.length} new ones`,
        );
        continue;
      }

      const data = {
        competition1: picks[0]?.name ?? null,
        whyCompetition1Fits: picks[0]?.why ?? null,
        competition2: picks[1]?.name ?? null,
        whyCompetition2Fits: picks[1]?.why ?? null,
        competition3: picks[2]?.name ?? null,
        whyCompetition3Fits: picks[2]?.why ?? null,
        projectId: project.id,
        runId: run.runId,
        generatedAt: new Date(),
        note: picks.length < 3 ? `only ${picks.length} eligible competitions matched` : null,
      };

      await prisma.enrolledTopPicks.upsert({
        where: { studentId: student.id },
        create: { studentId: student.id, ...data },
        update: data,
      });

      result.generated++;
      if (picks.length < 3) result.thin.push(`${student.name}: only ${picks.length} picks`);

      // The Day 9 email was skipped at signup because there were no picks yet.
      // Now that all three exist, put it back on the schedule — on its real day
      // if that is still ahead, otherwise as soon as the worker gets to it.
      const recipient = student.parentEmail?.trim() || student.user.email;
      if (picks.length === 3 && student.emailJourneyStartedAt && recipient) {
        const enqueued = await enqueueStep({
          journey: 'ENROLLED_EXTENSION_5',
          step: PICKS_EMAIL_STEP,
          to: recipient,
          ...(student.parentName || student.name
            ? { toName: student.parentName ?? student.name }
            : {}),
          variables: {
            'Student Name': student.name,
            ...(student.parentName ? { 'Parent Name': student.parentName } : {}),
            'Project Name': project.name ?? project.description.slice(0, 60),
            ...picksToVariables({
              competition1: data.competition1,
              whyCompetition1Fits: data.whyCompetition1Fits,
              competition2: data.competition2,
              whyCompetition2Fits: data.whyCompetition2Fits,
              competition3: data.competition3,
              whyCompetition3Fits: data.whyCompetition3Fits,
            }),
          },
          startAt: student.emailJourneyStartedAt,
        });
        if ('runAt' in enqueued) result.picksEmailsQueued++;
      }
    } catch (err) {
      result.failed.push({
        studentId: student.id,
        error: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }

  return result;
}

interface PayloadItem {
  reason: string;
  competition: { name: string } | null;
}

/** Merge variables for Flow 2 / Email 2, in the placeholder names the copy uses. */
export function picksToVariables(picks: {
  competition1: string | null;
  whyCompetition1Fits: string | null;
  competition2: string | null;
  whyCompetition2Fits: string | null;
  competition3: string | null;
  whyCompetition3Fits: string | null;
}): Record<string, string> {
  const vars: Record<string, string> = {};
  const rows = [
    [picks.competition1, picks.whyCompetition1Fits],
    [picks.competition2, picks.whyCompetition2Fits],
    [picks.competition3, picks.whyCompetition3Fits],
  ];
  rows.forEach(([name, why], i) => {
    if (name) {
      vars[`Competition ${i + 1}`] = name;
      vars[`Why it fits ${i + 1}`] = why ?? '';
    }
  });
  return vars;
}
