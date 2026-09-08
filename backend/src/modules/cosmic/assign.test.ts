import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { pushAssignment } from './assign.js';
import type { CosmicAssignResult, CosmicClient } from './client.js';

// The push reads the live config to decide whether COSMIC is reachable at all.
vi.mock('../../lib/config.js', () => ({
  config: {
    COSMIC_API_URL: 'https://cosmic.test',
    COSMIC_SERVICE_EMAIL: 'comp-ai@create-ed.in',
    COSMIC_SERVICE_PASSWORD: 'secret',
    COSMIC_PUSH_ENABLED: true,
    COSMIC_MAX_ATTEMPTS: 8,
    COSMIC_RETRY_BATCH_LIMIT: 50,
  },
  isProd: false,
}));

function stubPrisma(overrides: Record<string, unknown> = {}) {
  const updates: { where: { id: string }; data: Record<string, unknown> }[] = [];
  const studentUpdates: unknown[] = [];

  const prisma = {
    competitionAssignment: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'a1',
        status: 'READY',
        attempts: 0,
        competition: { slug: 'iris--in', name: 'IRIS', deadlineDate: new Date('2026-10-03') },
        student: {
          id: 's1',
          name: 'Arshiya',
          cosmicStudentId: null,
          parentEmail: 'parent@example.com',
          user: { email: 'kid@example.com' },
        },
        ...overrides,
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(args);
        return {};
      }),
    },
    student: {
      update: vi.fn(async (args: unknown) => {
        studentUpdates.push(args);
        return {};
      }),
    },
  } as unknown as PrismaClient;

  return { prisma, updates, studentUpdates };
}

function clientReturning(result: CosmicAssignResult | Error): CosmicClient {
  return {
    upsertTemplate: vi.fn(),
    assign: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  } as unknown as CosmicClient;
}

describe('pushAssignment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks the assignment SENT and caches the COSMIC student id', async () => {
    const { prisma, updates, studentUpdates } = stubPrisma();
    const client = clientReturning({
      status: 'assigned',
      student_id: 'cos-1',
      project_id: 'proj-1',
      template_id: 'tpl-1',
      enrollment_id: 'enr-1',
      competition_id: 'comp-1',
    });

    const outcome = await pushAssignment(prisma, 'a1', { client });

    expect(outcome.status).toBe('SENT');
    expect(updates[0]?.data).toMatchObject({
      status: 'SENT',
      cosmicEnrollmentId: 'enr-1',
      cosmicCompetitionId: 'comp-1',
      lastError: null,
    });
    // Every later push for this kid skips the email lookup.
    expect(studentUpdates).toHaveLength(1);
  });

  // The rule the whole queue exists for: a kid with no project in COSMIC gets
  // nothing written there, and the assignment waits.
  it('queues WAITING_FOR_PROJECT when the kid has no COSMIC project', async () => {
    const { prisma, updates } = stubPrisma();
    const client = clientReturning({ status: 'no_project', student_id: 'cos-1' });

    const outcome = await pushAssignment(prisma, 'a1', { client });

    expect(outcome.status).toBe('WAITING_FOR_PROJECT');
    expect(updates[0]?.data.sentAt).toBeUndefined();
    expect(updates[0]?.data.status).toBe('WAITING_FOR_PROJECT');
  });

  it('queues WAITING_FOR_STUDENT when COSMIC cannot match the kid', async () => {
    const { prisma } = stubPrisma();
    const client = clientReturning({ status: 'no_student' });

    expect((await pushAssignment(prisma, 'a1', { client })).status).toBe('WAITING_FOR_STUDENT');
  });

  it('treats an existing enrollment as done rather than an error', async () => {
    const { prisma } = stubPrisma();
    const client = clientReturning({ status: 'already_assigned', enrollment_id: 'enr-1' });

    expect((await pushAssignment(prisma, 'a1', { client })).status).toBe('SENT');
  });

  // A COSMIC outage is recorded, never thrown at the student mid-selection.
  it('records a transport failure without throwing', async () => {
    const { prisma, updates } = stubPrisma();
    const client = clientReturning(new Error('connect ECONNREFUSED'));

    const outcome = await pushAssignment(prisma, 'a1', { client });

    expect(outcome.status).toBe('FAILED');
    expect(updates[0]?.data).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(String(updates[0]?.data.lastError)).toContain('ECONNREFUSED');
  });

  it('does not re-push something already sent', async () => {
    const { prisma, updates } = stubPrisma({ status: 'SENT' });
    const client = clientReturning({ status: 'assigned' });

    const outcome = await pushAssignment(prisma, 'a1', { client });

    expect(outcome.status).toBe('SENT');
    expect(client.assign).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});
