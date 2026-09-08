/**
 * Start the right email flow the moment an account is created.
 *
 * The persona resolved at signup picks the sequence: a roster match gets Flow 2
 * (the enrolled extension sequence), everyone else gets Flow 1 (the lead
 * nurture). One signup path, two journeys — the same split as the rest of the app.
 *
 * This never throws into the signup request. A queue that is briefly unreachable
 * must not turn a successful account creation into a 500 the user sees.
 */

import type { Persona, PrismaClient } from '@prisma/client';
import { enqueueJourney } from './queue.js';
import { resolveProjectName } from './flow2-gate.js';
import { picksToVariables } from '../recommend/top-picks.js';

export interface SignupEmailInput {
  userId: string;
  email: string;
  persona: Persona;
  studentName?: string | null;
}

export type SignupEmailResult =
  | { journey: string; scheduled: number; skipped: number }
  | { deferred: string }
  | { error: string };

export async function startJourneyForSignup(
  prisma: PrismaClient,
  input: SignupEmailInput,
): Promise<SignupEmailResult> {
  try {
    const journey = input.persona === 'ENROLLED' ? 'ENROLLED_EXTENSION_5' : 'TOF_NURTURE_8';
    const startedAt = new Date();

    const student = await prisma.student.findUnique({
      where: { userId: input.userId },
      include: { topPicks: true, projects: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });

    const picks = student?.topPicks;
    // A brand-new signup has no picks yet, so the Day 9 email is skipped here and
    // backfilled by the nightly job once its three competitions exist.
    const hasPicks = Boolean(picks?.competition1 && picks?.competition2 && picks?.competition3);

    // Flow 2 is gated on a real project name. Flow 1 never references one.
    const { projectName } = student
      ? await resolveProjectName(prisma, student.id)
      : { projectName: null };

    if (journey === 'ENROLLED_EXTENSION_5' && !projectName) {
      return {
        deferred:
          'no project name on record — Flow 2 will start automatically once one is synced from the sheet or entered in the app',
      };
    }

    const variables: Record<string, string> = {
      ...(input.studentName ?? student?.name
        ? { 'Student Name': (input.studentName ?? student?.name)! }
        : {}),
      ...(student?.parentName ? { 'Parent Name': student.parentName } : {}),
      ...(projectName ? { 'Project Name': projectName } : {}),
      ...(picks ? picksToVariables(picks) : {}),
    };

    const to = student?.parentEmail?.trim() || input.email;
    const result = await enqueueJourney({
      journey,
      to,
      ...(student?.parentName || student?.name
        ? { toName: student.parentName ?? student.name }
        : {}),
      variables,
      startAt: startedAt,
      hasPicks,
    });

    if (student) {
      await prisma.student.update({
        where: { id: student.id },
        data: { emailJourneyStartedAt: startedAt },
      });
    }

    return {
      journey,
      scheduled: result.scheduled.length,
      skipped: result.skipped.length,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'failed to schedule emails' };
  }
}
