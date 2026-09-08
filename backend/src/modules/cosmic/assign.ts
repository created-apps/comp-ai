/**
 * Pushing an activated competition onto the kid in COSMIC.
 *
 * The assignment row is the record; COSMIC is the destination. Three outcomes
 * are ordinary rather than exceptional, and all three leave the row queued:
 *
 *  - COSMIC cannot find the student (a parent signed up, or the family uses a
 *    different address there) — WAITING_FOR_STUDENT, until an admin maps the id.
 *  - The student has no project in COSMIC yet — WAITING_FOR_PROJECT. A
 *    competition enrollment hangs off a project, so assigning without one would
 *    create a workspace with nothing behind it. We wait instead.
 *  - COSMIC is unreachable — FAILED with the reason, retried by the cron.
 *
 * Nothing in here is allowed to fail a selection. Callers fire it best-effort.
 */

import type { PrismaClient } from '@prisma/client';
import { config } from '../../lib/config.js';
import { cosmicClient, cosmicConfigured, type CosmicClient } from './client.js';

export interface PushOptions {
  client?: CosmicClient;
}

export interface PushOutcome {
  assignmentId: string;
  status: 'SENT' | 'WAITING_FOR_STUDENT' | 'WAITING_FOR_PROJECT' | 'FAILED' | 'READY';
  detail?: string;
}

/** ISO date (YYYY-MM-DD) — COSMIC's submission_date column is a DATE. */
function isoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

export async function pushAssignment(
  prisma: PrismaClient,
  assignmentId: string,
  options: PushOptions = {},
): Promise<PushOutcome> {
  const client = options.client ?? cosmicClient;

  const assignment = await prisma.competitionAssignment.findUnique({
    where: { id: assignmentId },
    include: {
      competition: { select: { slug: true, name: true, deadlineDate: true } },
      student: {
        select: {
          id: true,
          name: true,
          cosmicStudentId: true,
          parentEmail: true,
          user: { select: { email: true } },
        },
      },
    },
  });

  if (!assignment) throw new Error(`assignment ${assignmentId} not found`);
  if (assignment.status === 'SENT') {
    return { assignmentId, status: 'SENT', detail: 'already assigned' };
  }

  if (!cosmicConfigured() || !config.COSMIC_PUSH_ENABLED) {
    // Not an error: the queue is the point. Leave the row READY so enabling the
    // integration later drains everything that piled up.
    return { assignmentId, status: 'READY', detail: 'COSMIC push disabled' };
  }

  const attempts = assignment.attempts + 1;

  try {
    const result = await client.assign({
      compAiSlug: assignment.competition.slug,
      competitionName: assignment.competition.name,
      studentEmail: assignment.student.user.email,
      parentEmail: assignment.student.parentEmail,
      studentName: assignment.student.name,
      cosmicStudentId: assignment.student.cosmicStudentId,
      submissionDate: isoDate(assignment.competition.deadlineDate),
    });

    const status =
      result.status === 'assigned' || result.status === 'already_assigned'
        ? 'SENT'
        : result.status === 'no_project'
          ? 'WAITING_FOR_PROJECT'
          : 'WAITING_FOR_STUDENT';

    await prisma.competitionAssignment.update({
      where: { id: assignmentId },
      data: {
        status,
        attempts,
        lastAttemptAt: new Date(),
        lastError: status === 'SENT' ? null : (result.detail ?? result.status),
        ...(status === 'SENT' ? { sentAt: new Date() } : {}),
        ...(result.student_id ? { cosmicStudentId: result.student_id } : {}),
        ...(result.project_id ? { cosmicProjectId: result.project_id } : {}),
        ...(result.template_id ? { cosmicTemplateId: result.template_id } : {}),
        ...(result.enrollment_id ? { cosmicEnrollmentId: result.enrollment_id } : {}),
        ...(result.competition_id ? { cosmicCompetitionId: result.competition_id } : {}),
      },
    });

    // Cache the mapping on the student so every later push (and the admin
    // console) skips the email lookup entirely.
    if (result.student_id && !assignment.student.cosmicStudentId) {
      await prisma.student.update({
        where: { id: assignment.student.id },
        data: { cosmicStudentId: result.student_id },
      });
    }

    return { assignmentId, status, ...(result.detail ? { detail: result.detail } : {}) };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'COSMIC push failed';
    await prisma.competitionAssignment.update({
      where: { id: assignmentId },
      data: {
        status: 'FAILED',
        attempts,
        lastAttemptAt: new Date(),
        lastError: message.slice(0, 500),
      },
    });
    return { assignmentId, status: 'FAILED', detail: message };
  }
}

/**
 * Push several assignments without letting one failure abandon the rest — the
 * student selected them together and they should reach COSMIC together.
 */
export async function pushAssignments(
  prisma: PrismaClient,
  assignmentIds: string[],
  options: PushOptions = {},
): Promise<PushOutcome[]> {
  const outcomes: PushOutcome[] = [];
  for (const id of assignmentIds) {
    outcomes.push(
      await pushAssignment(prisma, id, options).catch((err: unknown) => ({
        assignmentId: id,
        status: 'FAILED' as const,
        detail: err instanceof Error ? err.message : 'push failed',
      })),
    );
  }
  return outcomes;
}
