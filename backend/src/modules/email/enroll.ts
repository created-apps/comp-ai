/**
 * Turn a student's stored picks into a scheduled email journey.
 *
 * The backend publishes and nothing else — no rendering, no SendGrid. It decides
 * who is due what, hands the merge variables over, and the worker owns delivery.
 */

import type { PrismaClient } from '@prisma/client';
import { picksToVariables } from '../recommend/top-picks.js';
import { resolveProjectName } from './flow2-gate.js';
import { enqueueJourney, type EnqueueResult } from './queue.js';

export interface StartResult extends EnqueueResult {
  studentId: string;
  to: string;
  hasPicks: boolean;
}

/**
 * Start Flow 2 for one enrolled student.
 *
 * Sends to the parent address when we have one — the copy is written to a
 * parent or student interchangeably ("Hi {{Student/Parent Name}}"), and for the
 * enrolled families the parent is the buying decision-maker.
 */
export async function startEnrolledJourney(
  prisma: PrismaClient,
  studentId: string,
): Promise<StartResult> {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: {
      user: { select: { email: true, persona: true } },
      topPicks: true,
      projects: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  if (!student) throw new Error('student not found');
  if (student.user.persona !== 'ENROLLED') {
    throw new Error('Flow 2 is for enrolled families; this account is TOF');
  }

  // The hard gate. Four of the five emails name the project; without it there is
  // nothing to send that would read as anything but a broken merge.
  const { projectName } = await resolveProjectName(prisma, student.id);
  if (!projectName) {
    throw new Error(
      'no project name on record for this student — add Project Name to their roster row, or have them name their project in the app',
    );
  }

  const to = student.parentEmail?.trim() || student.user.email;
  const picks = student.topPicks;
  const hasPicks = Boolean(picks?.competition1 && picks?.competition2 && picks?.competition3);

  const variables: Record<string, string> = {
    'Student Name': student.name,
    ...(student.parentName ? { 'Parent Name': student.parentName } : {}),
    'Project Name': projectName,
    ...(picks ? picksToVariables(picks) : {}),
  };

  const result = await enqueueJourney({
    journey: 'ENROLLED_EXTENSION_5',
    to,
    toName: student.parentName ?? student.name,
    variables,
    hasPicks,
  });

  if (hasPicks && picks) {
    await prisma.enrolledTopPicks.update({
      where: { id: picks.id },
      data: { emailedAt: new Date() },
    });
  }

  if (!student.emailJourneyStartedAt) {
    await prisma.student.update({
      where: { id: student.id },
      data: { emailJourneyStartedAt: new Date() },
    });
  }

  return { ...result, studentId, to, hasPicks };
}

export type ReadyResult =
  | { started: true; studentId: string; to: string; scheduled: number }
  | { started: false; reason: string };

/**
 * Start Flow 2 for a student who was previously blocked on a missing project
 * name — called whenever a project name arrives, from the roster sync or from
 * the app.
 *
 * Idempotent by design: `emailJourneyStartedAt` means the sequence already
 * began, and BullMQ job ids would dedupe a second attempt anyway. Both matter,
 * because the roster sync runs every five hours.
 */
export async function startEnrolledJourneyIfReady(
  prisma: PrismaClient,
  studentId: string,
): Promise<ReadyResult> {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: {
      id: true,
      emailJourneyStartedAt: true,
      user: { select: { persona: true } },
    },
  });

  if (!student) return { started: false, reason: 'student not found' };
  if (student.user.persona !== 'ENROLLED') return { started: false, reason: 'not enrolled' };
  if (student.emailJourneyStartedAt) return { started: false, reason: 'journey already started' };

  const { projectName } = await resolveProjectName(prisma, studentId);
  if (!projectName) return { started: false, reason: 'still no project name' };

  const result = await startEnrolledJourney(prisma, studentId);
  return { started: true, studentId, to: result.to, scheduled: result.scheduled.length };
}
