/**
 * Program entitlement — how many competitions one student may activate.
 *
 * The allowance is set per student in the internal console (a ProgramEnrolment
 * row) and falls back to a single configured default. It is deliberately not
 * read from the roster sheet: the sheet's package column is not reliably filled,
 * and silently defaulting a paying family to the wrong number is worse than
 * asking an internal user to set it once.
 *
 * `used` counts distinct COMPETITIONS across every run the student owns, not
 * items on the run being viewed. A project can be re-run any number of times, so
 * counting per run would hand out a fresh allowance with every regeneration.
 */

import type { PrismaClient } from '@prisma/client';
import { config } from '../../lib/config.js';

/** States that consume entitlement. Selection moves an item straight to ACTIVE. */
export const CONSUMING_STATES = ['SELECTED', 'ACTIVE'] as const;

export interface Entitlement {
  allowance: number;
  used: number;
  remaining: number;
  /** Competition ids the student has already spent entitlement on. */
  usedCompetitionIds: string[];
  /** True when no ProgramEnrolment exists and the configured default applies. */
  isDefault: boolean;
}

export async function getEntitlement(
  prisma: PrismaClient,
  studentId: string,
): Promise<Entitlement> {
  const [enrolments, items] = await Promise.all([
    prisma.programEnrolment.findMany({
      where: { studentId },
      select: { competitionAllowance: true },
    }),
    prisma.recommendationItem.findMany({
      where: {
        state: { in: [...CONSUMING_STATES] },
        run: { project: { studentId } },
      },
      select: { competitionId: true },
    }),
  ]);

  // A student on two packages holds the larger entitlement, not the sum of two
  // half-answers — packages describe an experience, they do not stack.
  const allowance =
    enrolments.length > 0
      ? Math.max(...enrolments.map((e) => e.competitionAllowance))
      : config.DEFAULT_COMPETITION_ALLOWANCE;

  const usedCompetitionIds = [...new Set(items.map((i) => i.competitionId))];
  const used = usedCompetitionIds.length;

  return {
    allowance,
    used,
    remaining: Math.max(0, allowance - used),
    usedCompetitionIds,
    isDefault: enrolments.length === 0,
  };
}
