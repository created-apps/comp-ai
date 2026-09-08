/**
 * Live sheet check at signup.
 *
 * The roster table is a mirror refreshed every five hours, so on its own it has
 * a five-hour window in which a student who was added to the sheet this morning
 * signs up and is told they are a public lead — landing them in the wrong
 * product, with the wrong email sequence, and needing a manual fix in /admin.
 *
 * So signup checks the mirror first and, only if that misses, asks the sheet
 * itself. A hit is written back to the roster immediately, so the rest of the
 * system sees it without waiting for the next sync.
 *
 * This never blocks signup. If the Sheets API is slow, misconfigured or down,
 * the local answer stands and the user gets an account either way — a failed
 * third-party call must not stop someone signing up.
 */

import type { PrismaClient } from '@prisma/client';
import { normalizeEmail, resolvePersona, type PersonaResolution } from '../../lib/persona.js';
import { config } from '../../lib/config.js';
import { fetchRosterRows } from './google-sheets.js';
import { parseRosterRows, type ParsedRosterEntry, type RosterRow } from './sync.js';

/** Signups arrive in bursts (a class, a webinar). Don't refetch per person. */
const CACHE_TTL_MS = 60_000;
/** Hard ceiling on the live lookup. Signup latency matters more than the check. */
const LOOKUP_TIMEOUT_MS = 8_000;

interface CacheEntry {
  fetchedAt: number;
  entries: ParsedRosterEntry[];
}

let cache: CacheEntry | null = null;

/** Test seam: inject rows instead of calling Google. */
export function primeSheetCache(rows: RosterRow[]): void {
  cache = { fetchedAt: Date.now(), entries: parseRosterRows(rows).entries };
}

export function clearSheetCache(): void {
  cache = null;
}

async function getSheetEntries(): Promise<ParsedRosterEntry[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.entries;

  const rows = await Promise.race([
    fetchRosterRows(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('sheet lookup timed out')), LOOKUP_TIMEOUT_MS),
    ),
  ]);

  cache = { fetchedAt: Date.now(), entries: parseRosterRows(rows).entries };
  return cache.entries;
}

/** Match on the student address or either parent address, as the sync does. */
export function findInEntries(
  entries: ParsedRosterEntry[],
  email: string,
): ParsedRosterEntry | null {
  const normalized = normalizeEmail(email);
  return (
    entries.find(
      (e) =>
        e.emailNormalized === normalized ||
        e.parentEmailNormalized === normalized ||
        e.parentEmail2Normalized === normalized,
    ) ?? null
  );
}

export interface SignupVerification extends PersonaResolution {
  /** Whether the live sheet was consulted, and what it said. */
  liveCheck: 'HIT' | 'MISS' | 'SKIPPED' | 'FAILED';
  liveCheckError?: string;
}

/**
 * The project CreatED already has on record for this family, if any.
 *
 * Signup uses it to ask "is this the project you want to continue with?" rather
 * than making an enrolled student retype work we already know about.
 */
export async function rosterProjectFor(
  prisma: PrismaClient,
  email: string,
): Promise<{ name: string | null; description: string | null; studentName: string | null } | null> {
  const normalized = normalizeEmail(email);
  const entry = await prisma.enrolledRosterEntry.findFirst({
    where: {
      active: true,
      OR: [
        { emailNormalized: normalized },
        { parentEmailNormalized: normalized },
        { parentEmail2Normalized: normalized },
      ],
    },
    select: { projectName: true, projectDescription: true, studentName: true },
  });

  if (!entry?.projectName && !entry?.projectDescription) return null;
  return {
    name: entry.projectName,
    description: entry.projectDescription,
    studentName: entry.studentName,
  };
}

export async function resolvePersonaForSignup(
  prisma: PrismaClient,
  email: string,
): Promise<SignupVerification> {
  const local = await resolvePersona(prisma, email);

  // Already enrolled per the mirror — nothing the sheet could add.
  if (local.persona === 'ENROLLED') return { ...local, liveCheck: 'SKIPPED' };

  if (!config.GOOGLE_SERVICE_ACCOUNT_JSON || !config.ROSTER_SHEET_ID) {
    return { ...local, liveCheck: 'SKIPPED' };
  }

  try {
    const entries = await getSheetEntries();
    const match = findInEntries(entries, email);
    if (!match) return { ...local, liveCheck: 'MISS' };

    // Found on the sheet but not in the mirror: write it through so the roster,
    // the project details and the persona are all correct from this moment.
    const data = {
      rawEmail: match.rawEmail,
      parentEmailNormalized: match.parentEmailNormalized,
      parentEmail2Normalized: match.parentEmail2Normalized,
      studentName: match.studentName,
      parentName: match.parentName,
      projectName: match.projectName,
      projectDescription: match.projectDescription,
      programTypes: match.programTypes,
      programTrack: match.programTrack,
      rawRow: match.rawRow as object,
      sheetRowNumber: match.sheetRowNumber,
      active: true,
    };

    const entry = await prisma.enrolledRosterEntry.upsert({
      where: { emailNormalized: match.emailNormalized },
      create: { emailNormalized: match.emailNormalized, ...data },
      update: data,
      select: { id: true },
    });

    return {
      persona: 'ENROLLED',
      reason:
        normalizeEmail(email) === match.emailNormalized
          ? 'ROSTER_STUDENT_EMAIL'
          : 'ROSTER_PARENT_EMAIL',
      rosterEntryId: entry.id,
      liveCheck: 'HIT',
    };
  } catch (err) {
    // The local answer stands. Signup must not depend on Google being up.
    return {
      ...local,
      liveCheck: 'FAILED',
      liveCheckError: err instanceof Error ? err.message : 'sheet lookup failed',
    };
  }
}
