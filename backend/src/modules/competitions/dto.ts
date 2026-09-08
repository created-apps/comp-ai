/**
 * Serialization boundary for competition records.
 *
 * THIS IS THE SECURITY SEAM. Everything that reaches a TOF surface — the public
 * matcher, the emailed report, the public chatbot's tool results — goes through
 * `toPublicDto`. It is an allowlist: internal fields are physically absent from
 * the returned object rather than set to null or filtered later, so a new column
 * on Competition cannot leak by default. Adding a field to the public shape has
 * to be a deliberate edit to this file.
 *
 * The chatbot's tools call these same functions. A prompt cannot talk the model
 * into returning a field the serializer never produced.
 */

import type { Competition, CompetitionMilestone } from '@prisma/client';
import type { PersonaPolicy } from '../../lib/persona.js';

/** Columns that must never cross the boundary to a TOF consumer. */
export const INTERNAL_COMPETITION_FIELDS = [
  'winnerLists',
  'notes',
  'comments',
  'internalGuidanceUrl',
  'sourceRows',
  'warnings',
  'contentHash',
] as const satisfies readonly (keyof Competition)[];

export interface PublicCompetitionDto {
  slug: string;
  name: string;
  description: string | null;
  domains: string[];
  regions: string[];
  eligibility: string | null;
  team: string | null;
  deadline: {
    date: string | null;
    text: string | null;
    precision: Competition['deadlinePrecision'];
    isRolling: boolean;
    /** Surfaced so the UI can say "verified 3 weeks ago" instead of asserting. */
    lastVerifiedAt: string | null;
  };
  registrationStatus: string | null;
  officialUrl: string | null;
  prestige: number | null;
  selectivity: number | null;
  difficulty: Competition['difficulty'];
}

export interface InternalCompetitionDto extends PublicCompetitionDto {
  id: string;
  submissionDetails: string | null;
  complexity: number | null;
  timeInvestment: number | null;
  totalScore: number | null;
  officialUrls: string[];
  winnerLists: string | null;
  notes: string | null;
  comments: string | null;
  internalGuidanceUrl: string | null;
  milestones: MilestoneDto[];
}

export interface MilestoneDto {
  id: string;
  cycle: string;
  order: number;
  name: string;
  type: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  dateText: string | null;
  status: CompetitionMilestone['status'];
}

export function toPublicDto(c: Competition): PublicCompetitionDto {
  return {
    slug: c.slug,
    name: c.name,
    description: c.description,
    domains: c.domains,
    regions: c.regions,
    eligibility: c.eligibilityRaw,
    team: c.teamRaw,
    deadline: {
      date: c.deadlineDate?.toISOString() ?? null,
      text: c.deadlineText,
      precision: c.deadlinePrecision,
      isRolling: c.isRolling,
      lastVerifiedAt: c.lastVerifiedAt?.toISOString() ?? null,
    },
    registrationStatus: c.registrationStatus,
    // one link only; the full list can expose internal or partner URLs
    officialUrl: c.officialUrls[0] ?? null,
    prestige: c.prestige,
    selectivity: c.selectivity,
    difficulty: c.difficulty,
  };
}

export function toInternalDto(
  c: Competition,
  milestones: CompetitionMilestone[] = [],
): InternalCompetitionDto {
  return {
    ...toPublicDto(c),
    id: c.id,
    submissionDetails: c.submissionDetails,
    complexity: c.complexity,
    timeInvestment: c.timeInvestment,
    totalScore: c.totalScore,
    officialUrls: c.officialUrls,
    winnerLists: c.winnerLists,
    notes: c.notes,
    comments: c.comments,
    internalGuidanceUrl: c.internalGuidanceUrl,
    milestones: milestones.map(toMilestoneDto),
  };
}

export function toMilestoneDto(m: CompetitionMilestone): MilestoneDto {
  return {
    id: m.id,
    cycle: m.cycle,
    order: m.order,
    name: m.name,
    type: m.type,
    dateStart: m.dateStart?.toISOString() ?? null,
    dateEnd: m.dateEnd?.toISOString() ?? null,
    dateText: m.dateText,
    status: m.status,
  };
}

/**
 * Persona-aware entry point. `activated` gates the internal view for enrolled
 * students: the requirements are explicit that only competitions the student
 * has actually activated unlock CreatED guidance — an enrolled persona alone
 * is not enough.
 */
export function serializeCompetition(
  c: Competition,
  policy: PersonaPolicy,
  opts: { activated?: boolean; milestones?: CompetitionMilestone[] } = {},
): PublicCompetitionDto | InternalCompetitionDto {
  if (policy.exposesInternalFields && opts.activated) {
    return toInternalDto(c, opts.milestones ?? []);
  }
  return toPublicDto(c);
}

/**
 * A locked TOF card: the user knows there are more matches, but gets nothing
 * usable until the lead gate. No name, no URL, no slug.
 */
export interface LockedCompetitionDto {
  locked: true;
  teaser: string;
  domains: string[];
}

export function toLockedDto(c: Competition): LockedCompetitionDto {
  return {
    locked: true,
    teaser: c.difficulty
      ? `A ${c.difficulty.toLowerCase()}-difficulty match in ${c.domains[0] ?? 'your field'}`
      : `A strong match in ${c.domains[0] ?? 'your field'}`,
    domains: c.domains.slice(0, 2),
  };
}
