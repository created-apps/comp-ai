import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { resolveProjectName } from './flow2-gate.js';

/** Minimal stub — only `project.findFirst` is exercised. */
function prismaWith(project: { id: string; name: string | null } | null): PrismaClient {
  return {
    project: { findFirst: vi.fn().mockResolvedValue(project) },
  } as unknown as PrismaClient;
}

describe('Flow 2 project-name gate', () => {
  it('returns the name when one exists', async () => {
    const result = await resolveProjectName(prismaWith({ id: 'p1', name: 'Sattu Fusion' }), 's1');
    expect(result).toEqual({ projectName: 'Sattu Fusion', projectId: 'p1' });
  });

  it('trims the stored value', async () => {
    const result = await resolveProjectName(prismaWith({ id: 'p1', name: '  Sattu  ' }), 's1');
    expect(result.projectName).toBe('Sattu');
  });

  // The whole point: no name means no Flow 2, ever, rather than a placeholder.
  it('blocks when the student has no project at all', async () => {
    const result = await resolveProjectName(prismaWith(null), 's1');
    expect(result).toEqual({ projectName: null, projectId: null });
  });

  it('blocks on a whitespace-only name — a blank cell in the sheet is not a name', async () => {
    const result = await resolveProjectName(prismaWith({ id: 'p1', name: '   ' }), 's1');
    expect(result.projectName).toBeNull();
  });

  it('only considers named projects the student has not dismissed', async () => {
    const prisma = prismaWith(null);
    await resolveProjectName(prisma, 's1');
    // Two exclusions in the query itself rather than filtered afterwards:
    // a description-only project cannot satisfy the gate, and a project the
    // student told us they are not continuing with must never drive an email.
    const call = (prisma.project.findFirst as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.where).toEqual({ studentId: 's1', NOT: { name: null }, dismissedAt: null });
    expect(call.orderBy).toEqual({ createdAt: 'desc' });
  });
});
