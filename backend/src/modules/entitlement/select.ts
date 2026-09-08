/**
 * Selection and activation — the one place entitlement is enforced.
 *
 * PLAN.md 7.1: an approved run is shown to the client, the client picks within
 * the program allowance, and a pick becomes ACTIVE. Activation is what unlocks
 * the competition inside COSMIC, so everything that decides "may this student
 * take this competition" lives in `selectCompetitions` — recommendation count
 * and paid access must never drift into each other.
 *
 * Two rules are structural rather than validated at the edge:
 *
 *  1. **Only an APPROVED run can be selected from.** The internal review gate is
 *     the whole reason enrolled output is not client-facing on generation; a
 *     selection endpoint that accepted a PENDING_REVIEW run would route around
 *     it.
 *  2. **Re-submitting the same picks is a no-op, not an error.** A double click,
 *     a retried request or a stale tab must not spend entitlement twice or
 *     create a second assignment — the assignment row is unique per item.
 */

import type { PrismaClient } from '@prisma/client';
import { getEntitlement, type Entitlement } from './allowance.js';

export type SelectionErrorCode =
  | 'RUN_NOT_FOUND'
  | 'NOT_YOURS'
  | 'NOT_APPROVED'
  | 'UNKNOWN_COMPETITION'
  | 'NOTHING_SELECTED'
  | 'OVER_ALLOWANCE';

export class SelectionError extends Error {
  constructor(
    readonly code: SelectionErrorCode,
    message: string,
    readonly status: number,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SelectionError';
  }
}

export interface ActivatedItem {
  itemId: string;
  competitionId: string;
  slug: string;
  name: string;
  assignmentId: string;
}

export interface SelectionResult {
  activated: ActivatedItem[];
  /** Ids that were already active — echoed so the client can render them as chosen. */
  alreadyActive: string[];
  entitlement: Entitlement;
}

/**
 * A pick may arrive as a competition id or as its slug. The payload the student
 * is looking at carries both, and which one the client happens to send is not a
 * reason to reject a selection.
 */
export async function selectCompetitions(
  prisma: PrismaClient,
  input: { studentId: string; runId: string; competitionIds: string[] },
): Promise<SelectionResult> {
  if (input.competitionIds.length === 0) {
    throw new SelectionError('NOTHING_SELECTED', 'select at least one competition', 400);
  }

  const run = await prisma.recommendationRun.findUnique({
    where: { id: input.runId },
    include: {
      project: { select: { studentId: true } },
      items: {
        select: {
          id: true,
          competitionId: true,
          state: true,
          competition: { select: { slug: true, name: true } },
        },
      },
    },
  });

  if (!run) throw new SelectionError('RUN_NOT_FOUND', 'recommendation set not found', 404);
  if (run.project.studentId !== input.studentId) {
    throw new SelectionError('NOT_YOURS', 'not your recommendations', 403);
  }
  if (run.status !== 'APPROVED') {
    throw new SelectionError(
      'NOT_APPROVED',
      'these recommendations are still with the CreatED team',
      409,
      { status: run.status },
    );
  }

  const byCompetition = new Map(run.items.map((i) => [i.competitionId, i]));
  const bySlug = new Map(run.items.map((i) => [i.competition.slug, i]));

  const unknown = input.competitionIds.filter(
    (ref) => !byCompetition.has(ref) && !bySlug.has(ref),
  );
  if (unknown.length > 0) {
    throw new SelectionError(
      'UNKNOWN_COMPETITION',
      'those competitions are not in this recommendation set',
      400,
      { unknown },
    );
  }

  const requested = [
    ...new Set(
      input.competitionIds.map((ref) => (byCompetition.get(ref) ?? bySlug.get(ref)!).competitionId),
    ),
  ];

  const entitlement = await getEntitlement(prisma, input.studentId);
  const alreadyActive = requested.filter((id) => entitlement.usedCompetitionIds.includes(id));
  const toActivate = requested.filter((id) => !entitlement.usedCompetitionIds.includes(id));

  if (toActivate.length > entitlement.remaining) {
    throw new SelectionError(
      'OVER_ALLOWANCE',
      entitlement.remaining === 0
        ? `Your program includes ${entitlement.allowance} ${entitlement.allowance === 1 ? 'competition' : 'competitions'} and ${entitlement.used === 1 ? 'one is' : 'they are'} already active.`
        : `Your program includes ${entitlement.allowance}. You can activate ${entitlement.remaining} more.`,
      409,
      { allowance: entitlement.allowance, used: entitlement.used, requested: toActivate.length },
    );
  }

  if (toActivate.length === 0) {
    return { activated: [], alreadyActive, entitlement };
  }

  const activated = await prisma.$transaction(async (tx) => {
    const created: ActivatedItem[] = [];
    const now = new Date();

    for (const competitionId of toActivate) {
      const item = byCompetition.get(competitionId)!;

      await tx.recommendationItem.update({
        where: { id: item.id },
        data: { state: 'ACTIVE', activatedAt: now },
      });

      // The assignment is the record that this kid owns this competition. It is
      // created here, inside the same transaction as the activation, so an
      // active item without a queued assignment cannot exist.
      const assignment = await tx.competitionAssignment.upsert({
        where: { recommendationItemId: item.id },
        create: {
          recommendationItemId: item.id,
          studentId: input.studentId,
          competitionId,
          status: 'READY',
        },
        update: {},
        select: { id: true },
      });

      created.push({
        itemId: item.id,
        competitionId,
        slug: item.competition.slug,
        name: item.competition.name,
        assignmentId: assignment.id,
      });
    }

    // Everything the student was offered but did not choose stops being a live
    // option on this run — it stays visible, it is simply no longer selectable.
    await tx.recommendationItem.updateMany({
      where: { runId: run.id, state: 'RECOMMENDED', competitionId: { notIn: requested } },
      data: { state: 'ARCHIVED' },
    });

    await tx.auditLog.create({
      data: {
        actorId: input.studentId,
        action: 'COMPETITIONS_SELECTED',
        entity: 'RecommendationRun',
        entityId: run.id,
        after: {
          competitionIds: toActivate,
          allowance: entitlement.allowance,
          usedBefore: entitlement.used,
        },
      },
    });

    return created;
  });

  return {
    activated,
    alreadyActive,
    entitlement: await getEntitlement(prisma, input.studentId),
  };
}
