/**
 * Enrolled-students roster sync.
 *
 * This is the whole product differentiator: a signup email that appears in the
 * roster gets the Enrolled Competition OS, everything else gets the TOF matcher.
 *
 * Sheet columns (only the email ones matter for matching):
 *   Student Name | Gender | Student Email | Student Phone Country Code | Student Phone |
 *   Parent Name | Parent Email | Parent Phone Country Code | Parent Phone | School Name |
 *   School Graduation Year | Program Type(s) | Program Track | Mentor Name | Mentor Email |
 *   Project Name | Project Description | Parent Name2 | Parent Email2 |
 *   Parent Phone Country Code2 | Parent Phone2 | Mentor Phone Number | tab_created | Sales POC
 *
 * All three addresses (student, parent, parent2) identify the same family —
 * whichever one a person signs up with must unlock the enrolled experience.
 */

import type { PrismaClient } from '@prisma/client';
import { normalizeEmail } from '../../lib/persona.js';
import { startEnrolledJourneyIfReady } from '../email/enroll.js';

export interface RosterRow {
  [column: string]: string | undefined;
}

export interface ParsedRosterEntry {
  emailNormalized: string;
  rawEmail: string;
  parentEmailNormalized: string | null;
  parentEmail2Normalized: string | null;
  studentName: string | null;
  parentName: string | null;
  projectName: string | null;
  projectDescription: string | null;
  programTypes: string[];
  programTrack: string | null;
  rawRow: RosterRow;
  sheetRowNumber: number;
}

/** Header lookup that survives casing, spacing and trailing-space drift. */
function pick(row: RosterRow, ...names: string[]): string | null {
  const keys = Object.keys(row);
  for (const name of names) {
    const target = name.toLowerCase().replace(/\s+/g, '');
    const key = keys.find((k) => k.toLowerCase().replace(/\s+/g, '') === target);
    const value = key ? row[key] : undefined;
    if (value && value.trim()) return value.trim();
  }
  return null;
}

function looksLikeEmail(value: string | null): value is string {
  return !!value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function parseRosterRows(rows: RosterRow[]): {
  entries: ParsedRosterEntry[];
  skipped: string[];
} {
  const entries: ParsedRosterEntry[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  rows.forEach((row, i) => {
    const rowNumber = i + 2; // 1-indexed with a header row
    const studentEmail = pick(row, 'Student Email');
    const parentEmail = pick(row, 'Parent Email');
    const parentEmail2 = pick(row, 'Parent Email2', 'Parent Email 2');
    const studentName = pick(row, 'Student Name');

    // A row with no usable address cannot gate anything — record it rather than
    // dropping it silently, because it means a real enrolled student may be
    // getting the TOF flow.
    const primary = looksLikeEmail(studentEmail)
      ? studentEmail
      : looksLikeEmail(parentEmail)
        ? parentEmail
        : looksLikeEmail(parentEmail2)
          ? parentEmail2
          : null;

    if (!primary) {
      if (studentName) skipped.push(`row ${rowNumber} (${studentName}): no valid email`);
      return;
    }

    const emailNormalized = normalizeEmail(primary);
    if (seen.has(emailNormalized)) {
      skipped.push(`row ${rowNumber} (${studentName ?? primary}): duplicate of an earlier row`);
      return;
    }
    seen.add(emailNormalized);

    const programTypes = (pick(row, 'Program Type(s)', 'Program Types') ?? '')
      .split(/[,/|]/)
      .map((p) => p.trim())
      .filter(Boolean);

    entries.push({
      emailNormalized,
      rawEmail: primary,
      parentName: pick(row, 'Parent Name') ?? pick(row, 'Parent Name2', 'Parent Name 2'),
      projectName: pick(row, 'Project Name'),
      projectDescription: pick(row, 'Project Description'),
      parentEmailNormalized:
        looksLikeEmail(parentEmail) && normalizeEmail(parentEmail) !== emailNormalized
          ? normalizeEmail(parentEmail)
          : null,
      parentEmail2Normalized:
        looksLikeEmail(parentEmail2) && normalizeEmail(parentEmail2) !== emailNormalized
          ? normalizeEmail(parentEmail2)
          : null,
      studentName,
      programTypes,
      programTrack: pick(row, 'Program Track'),
      rawRow: row,
      sheetRowNumber: rowNumber,
    });
  });

  return { entries, skipped };
}

export interface SyncResult {
  syncRunId: string;
  rowsSeen: number;
  added: number;
  updated: number;
  deactivated: number;
  personaUpgrades: number;
  flaggedForReview: string[];
  skipped: string[];
  /** Students whose profile (name, parent) was backfilled from the sheet. */
  profilesUpdated: number;
  /** Projects created or refreshed from the sheet's Project Name/Description. */
  projectsUpserted: number;
  /**
   * Flow 2 journeys that started because a project name finally arrived. These
   * families signed up before their project was on the sheet, so their emails
   * were deferred rather than sent with a placeholder.
   */
  journeysStarted: number;
  /**
   * Rows that synced fine but carry no Project Name. They cannot produce
   * competition picks, so the Day 9 email will never fire for them — this is
   * the list someone has to go fill in on the sheet.
   */
  missingProjectName: { email: string; studentName: string | null }[];
  status: 'OK' | 'PARTIAL' | 'FAILED';
}

/**
 * Diff-based sync. Two safety rules matter more than throughput:
 *
 *  1. An empty or tiny sheet never wipes the roster. A failed export would
 *     otherwise downgrade every paying family to the public flow in one run.
 *  2. Enrolled -> not-enrolled is never applied silently. Removal from the
 *     sheet deactivates the roster entry, but an existing ENROLLED user is
 *     flagged for a human rather than losing access automatically.
 */
export async function syncRoster(
  prisma: PrismaClient,
  rows: RosterRow[],
  opts: { minRowsGuard?: number } = {},
): Promise<SyncResult> {
  const run = await prisma.sheetSyncRun.create({ data: { status: 'RUNNING' } });
  const { entries, skipped } = parseRosterRows(rows);

  const existingCount = await prisma.enrolledRosterEntry.count({ where: { active: true } });
  const guard = opts.minRowsGuard ?? Math.floor(existingCount * 0.5);

  if (existingCount > 0 && entries.length < guard) {
    await prisma.sheetSyncRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        rowsSeen: entries.length,
        error: `refused: sheet returned ${entries.length} rows but the roster holds ${existingCount}. Last-known-good roster kept.`,
      },
    });
    return {
      syncRunId: run.id,
      rowsSeen: entries.length,
      added: 0,
      updated: 0,
      deactivated: 0,
      personaUpgrades: 0,
      flaggedForReview: [],
      skipped,
      profilesUpdated: 0,
      projectsUpserted: 0,
      journeysStarted: 0,
      missingProjectName: [],
      status: 'FAILED',
    };
  }

  let added = 0;
  let updated = 0;

  for (const entry of entries) {
    const existing = await prisma.enrolledRosterEntry.findUnique({
      where: { emailNormalized: entry.emailNormalized },
      select: { id: true },
    });

    const data = {
      rawEmail: entry.rawEmail,
      parentEmailNormalized: entry.parentEmailNormalized,
      parentEmail2Normalized: entry.parentEmail2Normalized,
      studentName: entry.studentName,
      parentName: entry.parentName,
      projectName: entry.projectName,
      projectDescription: entry.projectDescription,
      programTypes: entry.programTypes,
      programTrack: entry.programTrack,
      rawRow: entry.rawRow as object,
      sheetRowNumber: entry.sheetRowNumber,
      active: true,
      syncRunId: run.id,
    };

    await prisma.enrolledRosterEntry.upsert({
      where: { emailNormalized: entry.emailNormalized },
      create: { emailNormalized: entry.emailNormalized, ...data },
      update: data,
    });

    existing ? updated++ : added++;
  }

  // Entries absent from this export are deactivated, never deleted.
  const present = entries.map((e) => e.emailNormalized);
  const { count: deactivated } = await prisma.enrolledRosterEntry.updateMany({
    where: { active: true, emailNormalized: { notIn: present } },
    data: { active: false },
  });

  // --- apply sheet details to real accounts ------------------------------
  // The sheet is the programme record: it holds the student's name, the parent's
  // name and the project they actually built with us. Anyone who has signed up
  // gets those written onto their profile, so the email merge has a real
  // {{Project Name}} instead of a placeholder.
  let profilesUpdated = 0;
  let projectsUpserted = 0;
  let journeysStarted = 0;
  const missingProjectName: { email: string; studentName: string | null }[] = [];

  for (const entry of entries) {
    // Every row that synced cleanly is checked for a project name — including
    // rows that were already present from an earlier run, which is where the
    // gaps accumulate.
    if (!entry.projectName && !entry.projectDescription) {
      missingProjectName.push({ email: entry.rawEmail, studentName: entry.studentName });
    }

    const emails = [
      entry.emailNormalized,
      entry.parentEmailNormalized,
      entry.parentEmail2Normalized,
    ].filter((e): e is string => Boolean(e));

    const user = await prisma.user.findFirst({
      where: { emailNormalized: { in: emails } },
      select: { id: true, student: { select: { id: true, name: true } } },
    });
    if (!user) continue;

    const studentId = user.student?.id;
    if (!studentId) continue;

    // Only fill gaps. A student who edited their own name in the app should not
    // have it reverted by a stale sheet row.
    const profileData = {
      ...(entry.studentName && !user.student?.name ? { name: entry.studentName } : {}),
      ...(entry.parentName ? { parentName: entry.parentName } : {}),
      ...(entry.parentEmailNormalized ? { parentEmail: entry.parentEmailNormalized } : {}),
    };
    if (Object.keys(profileData).length > 0) {
      await prisma.student.update({ where: { id: studentId }, data: profileData });
      profilesUpdated++;
    }

    if (!entry.projectName && !entry.projectDescription) continue;

    // Scoped to source: 'SHEET' so a project the student wrote in the app is
    // never overwritten by the programme record.
    const existing = await prisma.project.findFirst({
      where: { studentId, source: 'SHEET' },
      select: { id: true },
    });

    const projectData = {
      name: entry.projectName,
      description: entry.projectDescription ?? entry.projectName ?? '',
      source: 'SHEET',
    };

    if (existing) {
      await prisma.project.update({ where: { id: existing.id }, data: projectData });
    } else {
      await prisma.project.create({ data: { studentId, ...projectData } });
    }
    projectsUpserted++;

    // Flow 2 is gated on a project name. If this student signed up before their
    // project reached the sheet, their emails were deferred — start them now.
    // No-op for anyone whose journey is already running.
    if (entry.projectName) {
      const started = await startEnrolledJourneyIfReady(prisma, studentId);
      if (started.started) journeysStarted++;
    }
  }

  // --- persona reconciliation -------------------------------------------
  const allEmails = new Set<string>();
  for (const e of entries) {
    allEmails.add(e.emailNormalized);
    if (e.parentEmailNormalized) allEmails.add(e.parentEmailNormalized);
    if (e.parentEmail2Normalized) allEmails.add(e.parentEmail2Normalized);
  }

  // Upgrade: someone who signed up before enrolling now matches the roster.
  const toUpgrade = await prisma.user.findMany({
    where: {
      persona: 'TOF',
      personaLockedAt: null,
      emailNormalized: { in: [...allEmails] },
    },
    select: { id: true, email: true },
  });

  for (const user of toUpgrade) {
    await prisma.user.update({ where: { id: user.id }, data: { persona: 'ENROLLED' } });
    await prisma.auditLog.create({
      data: {
        action: 'PERSONA_UPGRADED_BY_SYNC',
        entity: 'User',
        entityId: user.id,
        before: { persona: 'TOF' },
        after: { persona: 'ENROLLED', syncRunId: run.id },
      },
    });
  }

  // Downgrade candidates are only flagged. A sheet edit must not revoke paid
  // access — a human decides in the admin console.
  const stale = await prisma.user.findMany({
    where: {
      persona: 'ENROLLED',
      personaLockedAt: null,
      emailNormalized: { notIn: [...allEmails] },
    },
    select: { email: true },
  });

  const result: SyncResult = {
    syncRunId: run.id,
    rowsSeen: entries.length,
    added,
    updated,
    deactivated,
    personaUpgrades: toUpgrade.length,
    flaggedForReview: stale.map((u) => u.email),
    skipped,
    profilesUpdated,
    projectsUpserted,
    journeysStarted,
    missingProjectName,
    status: skipped.length > 0 ? 'PARTIAL' : 'OK',
  };

  await prisma.sheetSyncRun.update({
    where: { id: run.id },
    data: {
      status: result.status,
      finishedAt: new Date(),
      rowsSeen: result.rowsSeen,
      added,
      updated,
      deactivated,
      ...(skipped.length > 0 ? { error: skipped.slice(0, 20).join('; ') } : {}),
    },
  });

  return result;
}
