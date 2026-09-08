import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { selectCompetitions, SelectionError } from './select.js';

interface StubItem {
  id: string;
  competitionId: string;
  state: string;
  competition: { slug: string; name: string };
}

interface StubOptions {
  runStatus?: string;
  ownerStudentId?: string;
  items?: StubItem[];
  /** Items already consuming entitlement, across every run this student owns. */
  consumed?: { competitionId: string }[];
  allowance?: number | null;
}

function item(id: string, competitionId: string): StubItem {
  return {
    id,
    competitionId,
    state: 'RECOMMENDED',
    competition: { slug: `${competitionId}--in`, name: competitionId.toUpperCase() },
  };
}

function stubPrisma(options: StubOptions = {}) {
  const updates: unknown[] = [];
  const upserts: unknown[] = [];
  const archived: unknown[] = [];

  const tx = {
    recommendationItem: {
      update: vi.fn(async (args: unknown) => {
        updates.push(args);
        return {};
      }),
      updateMany: vi.fn(async (args: unknown) => {
        archived.push(args);
        return { count: 0 };
      }),
    },
    competitionAssignment: {
      upsert: vi.fn(async (args: { create: { recommendationItemId: string } }) => {
        upserts.push(args);
        return { id: `assign-${args.create.recommendationItemId}` };
      }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };

  const prisma = {
    recommendationRun: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'run1',
        status: options.runStatus ?? 'APPROVED',
        project: { studentId: options.ownerStudentId ?? 'student1' },
        items: options.items ?? [item('i1', 'c1'), item('i2', 'c2'), item('i3', 'c3')],
      }),
    },
    programEnrolment: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          options.allowance == null ? [] : [{ competitionAllowance: options.allowance }],
        ),
    },
    recommendationItem: {
      findMany: vi.fn().mockResolvedValue(options.consumed ?? []),
    },
    $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaClient;

  return { prisma, tx, updates, upserts, archived };
}

const input = (competitionIds: string[]) => ({
  studentId: 'student1',
  runId: 'run1',
  competitionIds,
});

describe('selectCompetitions', () => {
  it('activates the picks and queues one assignment each', async () => {
    const { prisma, tx, updates } = stubPrisma({ allowance: 2 });

    const result = await selectCompetitions(prisma, input(['c1', 'c2']));

    expect(result.activated.map((a) => a.competitionId)).toEqual(['c1', 'c2']);
    expect(result.activated.map((a) => a.assignmentId)).toEqual(['assign-i1', 'assign-i2']);
    expect(updates).toHaveLength(2);
    expect((updates[0] as { data: { state: string } }).data.state).toBe('ACTIVE');
    expect(tx.competitionAssignment.upsert).toHaveBeenCalledTimes(2);
  });

  // The gate that stops a paid entitlement and a recommendation count drifting.
  it('refuses more competitions than the program allows', async () => {
    const { prisma } = stubPrisma({ allowance: 1 });

    await expect(selectCompetitions(prisma, input(['c1', 'c2']))).rejects.toMatchObject({
      code: 'OVER_ALLOWANCE',
      status: 409,
    });
  });

  // Entitlement is spent per student, not per run — otherwise regenerating a
  // project would mint a fresh allowance every time.
  it('counts competitions already active on other runs', async () => {
    const { prisma } = stubPrisma({ allowance: 2, consumed: [{ competitionId: 'zz' }] });

    await expect(selectCompetitions(prisma, input(['c1', 'c2']))).rejects.toMatchObject({
      code: 'OVER_ALLOWANCE',
    });

    const one = await selectCompetitions(prisma, input(['c1']));
    expect(one.activated).toHaveLength(1);
  });

  // A double click, a retried request, a stale tab.
  it('is idempotent: re-selecting an active competition activates nothing new', async () => {
    const { prisma, tx } = stubPrisma({ allowance: 2, consumed: [{ competitionId: 'c1' }] });

    const result = await selectCompetitions(prisma, input(['c1']));

    expect(result.activated).toEqual([]);
    expect(result.alreadyActive).toEqual(['c1']);
    expect(tx.competitionAssignment.upsert).not.toHaveBeenCalled();
  });

  it('falls back to the configured default when no ProgramEnrolment is set', async () => {
    const { prisma } = stubPrisma({ allowance: null });

    const result = await selectCompetitions(prisma, input(['c1', 'c2']));
    expect(result.activated).toHaveLength(2);
    expect(result.entitlement.allowance).toBe(2);
    expect(result.entitlement.isDefault).toBe(true);
  });

  // The internal review gate is the reason enrolled output is not client-facing
  // on generation; selecting from an unapproved run would route straight around it.
  it('refuses a run that has not passed internal review', async () => {
    const { prisma } = stubPrisma({ runStatus: 'PENDING_REVIEW', allowance: 2 });

    await expect(selectCompetitions(prisma, input(['c1']))).rejects.toMatchObject({
      code: 'NOT_APPROVED',
      status: 409,
    });
  });

  it('refuses another student\'s recommendations', async () => {
    const { prisma } = stubPrisma({ ownerStudentId: 'someone-else', allowance: 2 });

    await expect(selectCompetitions(prisma, input(['c1']))).rejects.toMatchObject({
      code: 'NOT_YOURS',
      status: 403,
    });
  });

  // The payload the student is looking at carries both; which one the client
  // sends is not a reason to reject their selection.
  it('accepts a slug as readily as a competition id', async () => {
    const { prisma } = stubPrisma({ allowance: 2 });

    const result = await selectCompetitions(prisma, input(['c1--in', 'c2']));

    expect(result.activated.map((a) => a.competitionId)).toEqual(['c1', 'c2']);
  });

  it('refuses a competition that is not on the run', async () => {
    const { prisma } = stubPrisma({ allowance: 2 });

    await expect(selectCompetitions(prisma, input(['not-on-run']))).rejects.toBeInstanceOf(
      SelectionError,
    );
  });

  it('archives the competitions the student passed over', async () => {
    const { prisma, archived } = stubPrisma({ allowance: 2 });

    await selectCompetitions(prisma, input(['c1']));

    expect(archived).toHaveLength(1);
    expect((archived[0] as { where: { competitionId: { notIn: string[] } } }).where.competitionId
      .notIn).toEqual(['c1']);
  });
});
