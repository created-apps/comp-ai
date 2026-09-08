/**
 * Live verification of competition timelines.
 *
 * Only 19 of 237 masterlist rows carry an official URL, so verification cannot
 * depend on one. Instead the competition's own details — name, region, subject,
 * eligibility, last known deadline — are handed to Claude's server-side web
 * search, which finds the official source itself and reads the current cycle
 * off it. A stored URL, when present, is used as a hint rather than a gate.
 *
 * Three rules from the requirements are enforced structurally, not by prompt:
 *
 *  1. **TOF never triggers this.** The caller must hold a policy with
 *     `allowsWebVerification`; the guard is at the top of `verifyCompetition`.
 *  2. **Stored dates are never auto-overwritten.** Every run produces a
 *     VerificationEvent holding a proposed diff for a human to approve. Only
 *     `applyVerification` writes to the Competition, and only from an approved
 *     event.
 *  3. **Unverifiable is a state, not a guess.** If search finds nothing
 *     credible, the result is AWAITING_VERIFICATION — never an inferred date.
 */

import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Competition, PrismaClient, Prisma } from '@prisma/client';
import { assertNotRefused, getClaude, MODEL } from '../../lib/claude.js';
import type { PersonaPolicy } from '../../lib/persona.js';

/** Server-tool turns can pause; cap the continuations so a run cannot loop. */
const MAX_TURNS = 6;

const milestoneSchema = z.object({
  name: z.string().describe('e.g. Registration opens, Round 1 submission, Shortlist, Final pitch'),
  type: z
    .enum(['REGISTRATION', 'SUBMISSION', 'ROUND', 'RESULT', 'EVENT', 'OTHER'])
    .describe('The kind of milestone.'),
  date: z
    .string()
    .nullable()
    .describe('ISO date YYYY-MM-DD if a specific day is stated on the official source, else null.'),
  dateText: z
    .string()
    .nullable()
    .describe('The date exactly as the source words it, e.g. "mid-March 2026", "rolling".'),
  activatesOnQualification: z
    .boolean()
    .describe('True if this round only becomes relevant after qualifying from an earlier one.'),
});

const verificationSchema = z.object({
  found: z
    .boolean()
    .describe('True only if you located an official or clearly authoritative source for THIS competition.'),
  officialUrl: z.string().nullable().describe('The official competition page you relied on.'),
  sourceUrls: z.array(z.string()).describe('Every URL you used to reach this conclusion.'),
  confidence: z
    .enum(['HIGH', 'MEDIUM', 'LOW'])
    .describe('HIGH only when the official site itself states the current cycle dates.'),
  cycle: z.string().nullable().describe('The current cycle label, e.g. "2026".'),
  registrationStatus: z
    .enum(['OPEN', 'CLOSED', 'NOT_YET_OPEN', 'ROLLING', 'UNKNOWN'])
    .describe('Current registration state per the source.'),
  milestones: z.array(milestoneSchema).describe('Every dated stage of the current cycle, in order.'),
  eligibilityNote: z
    .string()
    .nullable()
    .describe('Any change to who can enter, if the source states it differently from what we hold.'),
  notes: z
    .string()
    .describe('What you found, what was ambiguous, and anything a human should check.'),
});

export type VerificationExtract = z.infer<typeof verificationSchema>;

const SYSTEM = `You verify the current cycle of a student competition using web search.

Method:
- Search for the competition by name plus its region and organiser. Prefer the organiser's own site; a school, blog or aggregator listing is not authoritative.
- Once you find the official page, fetch it and read the current cycle's dates off it.
- Competitions are often renamed, merged, or run by a different body year to year. If you cannot confirm the page is about the same competition we asked about, set found=false.

Hard rules:
- Never infer, extrapolate or "typical year" a date. If the source does not state it, the date is null.
- Do not assume this year's dates follow last year's pattern.
- If you only find last year's cycle, report the milestones you found and set confidence LOW with a note saying the current cycle is not yet published.
- found=false is a correct and useful answer. A wrong date reaches a student as a missed deadline.`;

function buildQuery(competition: Competition): string {
  const year = competition.deadlineYear ?? new Date().getFullYear();
  return [
    `COMPETITION TO VERIFY`,
    `name: ${competition.name}`,
    `region listed: ${competition.region}`,
    competition.domainsRaw ? `subject: ${competition.domainsRaw}` : null,
    competition.description ? `what we hold: ${competition.description}` : null,
    competition.eligibilityRaw ? `eligibility we hold: ${competition.eligibilityRaw}` : null,
    competition.teamRaw ? `team format we hold: ${competition.teamRaw}` : null,
    competition.deadlineText ? `deadline we hold: ${competition.deadlineText}` : 'deadline we hold: none',
    competition.submissionDetails ? `submission notes we hold: ${competition.submissionDetails}` : null,
    competition.officialUrls[0] ? `possible official URL (unconfirmed): ${competition.officialUrls[0]}` : null,
    ``,
    `Find the official source and report the ${year} cycle. If the ${year} cycle is not published yet, say so.`,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/**
 * Run one verification. Returns the model's reading of the official source —
 * it does not write to the Competition.
 */
export async function runWebVerification(competition: Competition): Promise<{
  extract: VerificationExtract | null;
  sourceUrls: string[];
  toolErrors: string[];
}> {
  const client = getClaude();
  const toolErrors: string[] = [];

  const messages: Parameters<typeof client.messages.parse>[0]['messages'] = [
    { role: 'user', content: buildQuery(competition) },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const message = await client.messages.parse({
      model: MODEL,
      max_tokens: 8192,
      system: SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: zodOutputFormat(verificationSchema) },
      tools: [
        { type: 'web_search_20260209', name: 'web_search', max_uses: 8 },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
      ],
      messages,
    });

    assertNotRefused(message);

    // Server-tool failures come back as HTTP 200 with an error object inside the
    // result block — they never throw. Collecting them matters: silently
    // treating a blocked fetch as "nothing found" would look like a verified
    // no-change, which is the exact failure this system must not have.
    for (const block of message.content) {
      if (block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result') {
        const content: unknown = block.content;
        if (!Array.isArray(content) && typeof content === 'object' && content !== null) {
          const code = (content as { error_code?: string }).error_code;
          if (code) toolErrors.push(`${block.type}: ${code}`);
        }
      }
    }

    if (message.stop_reason === 'pause_turn') {
      // The server paused mid-tool-run; hand the turn back to continue.
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }

    const extract = message.parsed_output ?? null;
    const sourceUrls = extract?.sourceUrls ?? [];
    return { extract, sourceUrls, toolErrors };
  }

  return { extract: null, sourceUrls: [], toolErrors: [...toolErrors, 'exceeded turn limit'] };
}

export interface DiffEntry {
  field: string;
  from: string | null;
  to: string | null;
}

/** What would change if a human approved this reading. */
export function buildDiff(competition: Competition, extract: VerificationExtract): DiffEntry[] {
  const diff: DiffEntry[] = [];

  const firstDated = extract.milestones.find((m) => m.date);
  const proposedDeadline = firstDated?.date ?? null;
  const currentDeadline = competition.deadlineDate?.toISOString().slice(0, 10) ?? null;

  if (proposedDeadline && proposedDeadline !== currentDeadline) {
    diff.push({ field: 'deadlineDate', from: currentDeadline, to: proposedDeadline });
  }
  if (extract.cycle && extract.cycle !== competition.cycle) {
    diff.push({ field: 'cycle', from: competition.cycle, to: extract.cycle });
  }
  if (
    extract.registrationStatus !== 'UNKNOWN' &&
    extract.registrationStatus !== competition.registrationStatus
  ) {
    diff.push({
      field: 'registrationStatus',
      from: competition.registrationStatus,
      to: extract.registrationStatus,
    });
  }
  if (extract.officialUrl && !competition.officialUrls.includes(extract.officialUrl)) {
    diff.push({ field: 'officialUrl', from: competition.officialUrls[0] ?? null, to: extract.officialUrl });
  }
  if (extract.milestones.length !== 0) {
    diff.push({
      field: 'milestones',
      from: `${competition.id ? '' : ''}stored`,
      to: `${extract.milestones.length} milestone(s) from the official source`,
    });
  }

  return diff;
}

export type VerificationOutcome =
  | 'PENDING_REVIEW'
  | 'NO_CHANGE'
  | 'AWAITING_VERIFICATION'
  | 'FAILED';

export interface VerifyResult {
  eventId: string | null;
  outcome: VerificationOutcome;
  diff: DiffEntry[];
  confidence: VerificationExtract['confidence'] | null;
  message: string;
}

export async function verifyCompetition(
  prisma: PrismaClient,
  competitionId: string,
  opts: {
    policy: PersonaPolicy;
    trigger: 'PRE_ACTIVATION' | 'PERIODIC' | 'PRE_MILESTONE' | 'MANUAL';
  },
): Promise<VerifyResult> {
  // Rule 1, enforced at the boundary: the public matcher must never web-search.
  if (!opts.policy.allowsWebVerification) {
    throw new Error('web verification is not permitted for this persona');
  }

  const competition = await prisma.competition.findUnique({ where: { id: competitionId } });
  if (!competition) throw new Error(`competition ${competitionId} not found`);

  let extract: VerificationExtract | null = null;
  let toolErrors: string[] = [];
  try {
    const run = await runWebVerification(competition);
    extract = run.extract;
    toolErrors = run.toolErrors;
  } catch (err) {
    const event = await prisma.verificationEvent.create({
      data: {
        competitionId,
        trigger: opts.trigger,
        sourceUrl: competition.officialUrls[0] ?? '',
        status: 'FAILED',
        diff: { error: err instanceof Error ? err.message : 'unknown error' } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return {
      eventId: event.id,
      outcome: 'FAILED',
      diff: [],
      confidence: null,
      message: err instanceof Error ? err.message : 'verification failed',
    };
  }

  // Rule 3: nothing credible found means the milestone is marked unverified,
  // never filled in with a plausible-looking date.
  if (!extract || !extract.found || extract.milestones.length === 0) {
    const event = await prisma.verificationEvent.create({
      data: {
        competitionId,
        trigger: opts.trigger,
        sourceUrl: extract?.officialUrl ?? competition.officialUrls[0] ?? '',
        status: 'FAILED',
        extracted: (extract ?? {}) as unknown as Prisma.InputJsonValue,
        diff: {
          reason: 'no authoritative source found',
          toolErrors,
        } as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    await prisma.competitionMilestone.updateMany({
      where: { competitionId },
      data: { status: 'AWAITING_VERIFICATION' },
    });

    return {
      eventId: event.id,
      outcome: 'AWAITING_VERIFICATION',
      diff: [],
      confidence: extract?.confidence ?? null,
      message:
        toolErrors.length > 0
          ? `search could not complete (${toolErrors.join(', ')}) — marked awaiting verification`
          : 'no authoritative source found — marked awaiting verification',
    };
  }

  const diff = buildDiff(competition, extract);

  if (diff.length === 0) {
    const event = await prisma.verificationEvent.create({
      data: {
        competitionId,
        trigger: opts.trigger,
        sourceUrl: extract.officialUrl ?? '',
        status: 'NO_CHANGE',
        extracted: extract as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    // Nothing changed, so recording that we looked is safe and useful.
    await prisma.competition.update({
      where: { id: competitionId },
      data: { lastVerifiedAt: new Date() },
    });
    return {
      eventId: event.id,
      outcome: 'NO_CHANGE',
      diff: [],
      confidence: extract.confidence,
      message: 'official source matches what we hold',
    };
  }

  // Rule 2: a change is a proposal. Nothing is written to the competition here.
  const event = await prisma.verificationEvent.create({
    data: {
      competitionId,
      trigger: opts.trigger,
      sourceUrl: extract.officialUrl ?? '',
      status: 'PENDING_REVIEW',
      extracted: extract as unknown as Prisma.InputJsonValue,
      diff: { changes: diff, toolErrors } as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  return {
    eventId: event.id,
    outcome: 'PENDING_REVIEW',
    diff,
    confidence: extract.confidence,
    message: `${diff.length} proposed change(s) awaiting human approval`,
  };
}

/**
 * Apply an approved verification. This is the only path that mutates a
 * Competition's dates, and it writes an audit entry with before/after.
 */
export async function applyVerification(
  prisma: PrismaClient,
  eventId: string,
  reviewerId: string,
): Promise<{ applied: DiffEntry[] }> {
  const event = await prisma.verificationEvent.findUnique({ where: { id: eventId } });
  if (!event) throw new Error('verification event not found');
  if (event.status !== 'PENDING_REVIEW') {
    throw new Error(`event is ${event.status}, only PENDING_REVIEW can be applied`);
  }

  const competition = await prisma.competition.findUnique({ where: { id: event.competitionId } });
  if (!competition) throw new Error('competition not found');

  const extract = event.extracted as unknown as VerificationExtract;
  const changes = (event.diff as unknown as { changes: DiffEntry[] })?.changes ?? [];

  const firstDated = extract.milestones.find((m) => m.date);
  const before = {
    deadlineDate: competition.deadlineDate,
    cycle: competition.cycle,
    registrationStatus: competition.registrationStatus,
    officialUrls: competition.officialUrls,
  };

  await prisma.competition.update({
    where: { id: competition.id },
    data: {
      ...(firstDated?.date ? { deadlineDate: new Date(`${firstDated.date}T00:00:00Z`), deadlinePrecision: 'DAY' } : {}),
      ...(extract.cycle ? { cycle: extract.cycle } : {}),
      ...(extract.registrationStatus !== 'UNKNOWN'
        ? { registrationStatus: extract.registrationStatus }
        : {}),
      ...(extract.officialUrl && !competition.officialUrls.includes(extract.officialUrl)
        ? { officialUrls: [extract.officialUrl, ...competition.officialUrls] }
        : {}),
      lastVerifiedAt: new Date(),
      verifiedById: reviewerId,
    },
  });

  // Milestones are replaced wholesale for the cycle: organisers add, rename and
  // remove rounds, so a merge would leave stale stages behind.
  const cycle = extract.cycle ?? competition.cycle ?? String(new Date().getFullYear());
  await prisma.competitionMilestone.deleteMany({ where: { competitionId: competition.id, cycle } });
  await prisma.competitionMilestone.createMany({
    data: extract.milestones.map((m, index) => ({
      competitionId: competition.id,
      cycle,
      order: index,
      name: m.name,
      type: m.type,
      ...(m.date ? { dateStart: new Date(`${m.date}T00:00:00Z`) } : {}),
      dateText: m.dateText,
      status: m.date ? ('VERIFIED' as const) : ('AWAITING_VERIFICATION' as const),
      sourceUrl: extract.officialUrl,
      lastVerifiedAt: new Date(),
      verifiedById: reviewerId,
      activatesOnQualification: m.activatesOnQualification,
    })),
  });

  await prisma.verificationEvent.update({
    where: { id: eventId },
    data: { status: 'APPROVED', reviewedById: reviewerId, reviewedAt: new Date() },
  });

  await prisma.auditLog.create({
    data: {
      actorId: reviewerId,
      action: 'VERIFICATION_APPLIED',
      entity: 'Competition',
      entityId: competition.id,
      before: before as unknown as Prisma.InputJsonValue,
      after: { changes, sourceUrl: extract.officialUrl } as unknown as Prisma.InputJsonValue,
    },
  });

  return { applied: changes };
}
