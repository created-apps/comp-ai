/**
 * The periodic verification sweep.
 *
 * Every competition in the repository was ingested from a spreadsheet and, until
 * something checks it against the organiser's own site, `lastVerifiedAt` is null
 * — which is the honest state, and the reason the UI says "deadline not
 * published" rather than showing a date. The sweep is what moves rows out of
 * that state.
 *
 * Two properties matter more than coverage:
 *
 *  1. **Order by who is depending on it.** A competition a student has actually
 *     activated is worth verifying today; one nobody has been shown can wait.
 *     Verifying 237 rows on a schedule would cost more and help less than
 *     verifying the handful that are in front of families right now.
 *  2. **Never re-ask a question a human has not answered.** A competition with a
 *     proposal already sitting in the review queue is skipped: running it again
 *     produces a second identical diff for the same reviewer.
 *
 * Each verification is a multi-turn web-search model call — slow and not free —
 * so the batch is small and the loop is sequential by design.
 */

import type { PrismaClient } from '@prisma/client';
import { policyFor } from '../../lib/persona.js';
import { verifyCompetition, type VerificationOutcome } from './verify.js';

/** Why this competition was picked. Ordered: earlier means more urgent. */
export type VerificationReason =
  | 'ACTIVATED'
  | 'DELIVERED'
  | 'DEADLINE_SOON'
  | 'NEVER_VERIFIED'
  | 'STALE';

const REASON_TRIGGER: Record<VerificationReason, 'PERIODIC' | 'PRE_MILESTONE'> = {
  ACTIVATED: 'PERIODIC',
  DELIVERED: 'PERIODIC',
  // A competition whose deadline is close is exactly the pre-milestone case:
  // a stale date here is a missed deadline, not a cosmetic error.
  DEADLINE_SOON: 'PRE_MILESTONE',
  NEVER_VERIFIED: 'PERIODIC',
  STALE: 'PERIODIC',
};

const PRIORITY: VerificationReason[] = [
  'ACTIVATED',
  'DELIVERED',
  'DEADLINE_SOON',
  'NEVER_VERIFIED',
  'STALE',
];

export interface Candidate {
  id: string;
  name: string;
  reason: VerificationReason;
  trigger: 'PERIODIC' | 'PRE_MILESTONE';
}

export interface CandidateSets {
  activated: { id: string; name: string }[];
  delivered: { id: string; name: string }[];
  deadlineSoon: { id: string; name: string }[];
  neverVerified: { id: string; name: string }[];
  stale: { id: string; name: string }[];
}

/**
 * Merge the candidate sets into one ordered, deduplicated batch.
 *
 * Pure, because this is the part worth being sure about: a competition that
 * qualifies three ways must appear once, under its most urgent reason, and the
 * batch must never exceed the cap that bounds the cost of a tick.
 */
export function rankCandidates(
  sets: CandidateSets,
  opts: { limit: number; excludeIds?: Iterable<string> },
): Candidate[] {
  const excluded = new Set(opts.excludeIds ?? []);
  const seen = new Set<string>();
  const batch: Candidate[] = [];

  const byReason: Record<VerificationReason, { id: string; name: string }[]> = {
    ACTIVATED: sets.activated,
    DELIVERED: sets.delivered,
    DEADLINE_SOON: sets.deadlineSoon,
    NEVER_VERIFIED: sets.neverVerified,
    STALE: sets.stale,
  };

  for (const reason of PRIORITY) {
    for (const competition of byReason[reason]) {
      if (batch.length >= opts.limit) return batch;
      if (excluded.has(competition.id) || seen.has(competition.id)) continue;
      seen.add(competition.id);
      batch.push({ ...competition, reason, trigger: REASON_TRIGGER[reason] });
    }
  }

  return batch;
}

export interface SweepOptions {
  limit: number;
  /** A verification older than this is worth repeating. */
  staleDays: number;
  /** A deadline inside this window makes a competition urgent. */
  deadlineWindowDays: number;
  /** Do not re-verify anything looked at this recently. */
  cooldownHours: number;
}

/** The competitions this tick should verify, most urgent first. */
export async function pickCompetitionsToVerify(
  prisma: PrismaClient,
  opts: SweepOptions,
): Promise<Candidate[]> {
  const now = Date.now();
  const staleBefore = new Date(now - opts.staleDays * 24 * 60 * 60 * 1000);
  const deadlineBefore = new Date(now + opts.deadlineWindowDays * 24 * 60 * 60 * 1000);
  const cooldownSince = new Date(now - opts.cooldownHours * 60 * 60 * 1000);

  const select = { id: true, name: true } as const;
  const active = { cycleActive: true } as const;

  const [recentEvents, awaitingReview, activatedItems] = await Promise.all([
    // Looked at recently — including failures. A site that could not be reached
    // an hour ago will not have appeared since, and retrying it every tick would
    // crowd out everything else.
    prisma.verificationEvent.findMany({
      where: { fetchedAt: { gte: cooldownSince } },
      select: { competitionId: true },
    }),
    // A proposal a human has not ruled on yet.
    prisma.verificationEvent.findMany({
      where: { status: 'PENDING_REVIEW' },
      select: { competitionId: true },
    }),
    prisma.recommendationItem.findMany({
      where: { state: { in: ['SELECTED', 'ACTIVE'] } },
      select: { competitionId: true },
    }),
  ]);

  const excludeIds = new Set([
    ...recentEvents.map((e) => e.competitionId),
    ...awaitingReview.map((e) => e.competitionId),
  ]);
  const activatedIds = [...new Set(activatedItems.map((i) => i.competitionId))];

  const [activated, delivered, deadlineSoon, neverVerified, stale] = await Promise.all([
    prisma.competition.findMany({
      where: { id: { in: activatedIds } },
      select,
      orderBy: { lastVerifiedAt: { sort: 'asc', nulls: 'first' } },
    }),
    // In a set a reviewer approved, so a family can see it.
    prisma.competition.findMany({
      where: {
        ...active,
        recommendationItems: { some: { run: { status: { in: ['APPROVED', 'DELIVERED'] } } } },
      },
      select,
      orderBy: { lastVerifiedAt: { sort: 'asc', nulls: 'first' } },
      take: opts.limit * 2,
    }),
    prisma.competition.findMany({
      where: {
        ...active,
        deadlineDate: { not: null, gte: new Date(now), lte: deadlineBefore },
        OR: [{ lastVerifiedAt: null }, { lastVerifiedAt: { lt: staleBefore } }],
      },
      select,
      orderBy: { deadlineDate: 'asc' },
      take: opts.limit * 2,
    }),
    prisma.competition.findMany({
      where: { ...active, lastVerifiedAt: null },
      select,
      // Soonest deadline first: an undated row can wait, a row closing next month
      // cannot. Nulls last so they do not monopolise the batch.
      orderBy: { deadlineDate: { sort: 'asc', nulls: 'last' } },
      take: opts.limit * 2,
    }),
    prisma.competition.findMany({
      where: { ...active, lastVerifiedAt: { lt: staleBefore } },
      select,
      orderBy: { lastVerifiedAt: 'asc' },
      take: opts.limit * 2,
    }),
  ]);

  return rankCandidates(
    { activated, delivered, deadlineSoon, neverVerified, stale },
    { limit: opts.limit, excludeIds },
  );
}

export interface SweepSummary {
  attempted: number;
  byOutcome: Record<string, number>;
  /** Proposals now waiting on a human. Nothing is applied without one. */
  pendingReview: number;
  results: { name: string; reason: VerificationReason; outcome: VerificationOutcome | 'ERROR'; message: string }[];
}

export async function runVerificationSweep(
  prisma: PrismaClient,
  opts: SweepOptions,
): Promise<SweepSummary> {
  const candidates = await pickCompetitionsToVerify(prisma, opts);
  const summary: SweepSummary = { attempted: 0, byOutcome: {}, pendingReview: 0, results: [] };

  for (const candidate of candidates) {
    summary.attempted++;
    try {
      // The ENROLLED policy is what permits web verification at all; the guard
      // lives inside verifyCompetition and this is the only policy that passes it.
      const result = await verifyCompetition(prisma, candidate.id, {
        policy: policyFor('ENROLLED'),
        trigger: candidate.trigger,
      });
      summary.byOutcome[result.outcome] = (summary.byOutcome[result.outcome] ?? 0) + 1;
      if (result.outcome === 'PENDING_REVIEW') summary.pendingReview++;
      summary.results.push({
        name: candidate.name,
        reason: candidate.reason,
        outcome: result.outcome,
        message: result.message,
      });
    } catch (err) {
      // One competition's failure must not end the sweep — the next one may be
      // the one a student is waiting on.
      summary.byOutcome.ERROR = (summary.byOutcome.ERROR ?? 0) + 1;
      summary.results.push({
        name: candidate.name,
        reason: candidate.reason,
        outcome: 'ERROR',
        message: err instanceof Error ? err.message : 'verification threw',
      });
    }
  }

  return summary;
}

/**
 * Verify the competitions a student has just activated.
 *
 * PLAN.md 7.3 names pre-activation as a verification trigger, and it is the one
 * that matters most: the moment a competition stops being a suggestion and
 * becomes the thing a family is working towards, its deadline had better be
 * real. Fired best-effort after the selection has been committed — it takes
 * about a minute per competition and must never sit in front of the student's
 * response.
 *
 * Anything already checked within the cooldown is skipped, so selecting a
 * competition the sweep looked at this morning costs nothing.
 */
export async function verifyOnActivation(
  prisma: PrismaClient,
  competitionIds: string[],
  opts: { cooldownHours: number },
): Promise<SweepSummary> {
  const cooldownSince = new Date(Date.now() - opts.cooldownHours * 60 * 60 * 1000);

  const recent = await prisma.verificationEvent.findMany({
    where: { competitionId: { in: competitionIds }, fetchedAt: { gte: cooldownSince } },
    select: { competitionId: true },
  });
  const skip = new Set(recent.map((e) => e.competitionId));

  const competitions = await prisma.competition.findMany({
    where: { id: { in: competitionIds.filter((id) => !skip.has(id)) } },
    select: { id: true, name: true },
  });

  const summary: SweepSummary = { attempted: 0, byOutcome: {}, pendingReview: 0, results: [] };

  for (const competition of competitions) {
    summary.attempted++;
    try {
      const result = await verifyCompetition(prisma, competition.id, {
        policy: policyFor('ENROLLED'),
        trigger: 'PRE_ACTIVATION',
      });
      summary.byOutcome[result.outcome] = (summary.byOutcome[result.outcome] ?? 0) + 1;
      if (result.outcome === 'PENDING_REVIEW') summary.pendingReview++;
      summary.results.push({
        name: competition.name,
        reason: 'ACTIVATED',
        outcome: result.outcome,
        message: result.message,
      });
    } catch (err) {
      summary.byOutcome.ERROR = (summary.byOutcome.ERROR ?? 0) + 1;
      summary.results.push({
        name: competition.name,
        reason: 'ACTIVATED',
        outcome: 'ERROR',
        message: err instanceof Error ? err.message : 'verification threw',
      });
    }
  }

  return summary;
}
