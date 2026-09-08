/**
 * Persona resolution and policy.
 *
 * This is the whole differentiator between the two products. One platform, one
 * pipeline; a roster lookup decides which policy applies. Every behavioural
 * difference between the TOF matcher and the Enrolled Competition OS is a field
 * on PersonaPolicy — not a branch scattered through the codebase, and never a
 * prompt instruction.
 */

import type { PrismaClient } from '@prisma/client';

export type Persona = 'TOF' | 'ENROLLED';

export interface PersonaPolicy {
  /** Upper bound on competitions in one recommendation set. */
  maxResults: number;
  /** Always-first results, by slug. TOF gets CREST Gold as the free sample. */
  pinnedCompetitionSlugs: string[];
  /** Recommendations must be approved by the internal team before the client sees them. */
  requiresInternalApproval: boolean;
  /** Whether live web verification may run for this persona. */
  allowsWebVerification: boolean;
  /** Whether internal notes / guidance / winner data may be serialized. */
  exposesInternalFields: boolean;
  /** One report per email address, resent rather than regenerated. */
  oneReportPerEmail: boolean;
  emailJourney: 'TOF_NURTURE_8' | 'ENROLLED_EXTENSION_5';
  /** Activation limited by the student's program allowance. */
  entitlementDriven: boolean;
  /** What the chatbot is allowed to read. */
  chatKnowledgeScope: 'PUBLIC' | 'ACTIVATED_INTERNAL';
  /** Turns allowed in one chat session; null = unlimited. */
  chatTurnLimit: number | null;
  /** Distinct competitions one chat session may reveal, guarding enumeration. */
  chatCompetitionExposureCap: number | null;
}

export const POLICIES: Record<Persona, PersonaPolicy> = {
  TOF: {
    maxResults: 8,
    pinnedCompetitionSlugs: ['crest-awards'],
    requiresInternalApproval: false,
    allowsWebVerification: false,
    exposesInternalFields: false,
    oneReportPerEmail: true,
    emailJourney: 'TOF_NURTURE_8',
    entitlementDriven: false,
    chatKnowledgeScope: 'PUBLIC',
    chatTurnLimit: 10,
    chatCompetitionExposureCap: 8,
  },
  ENROLLED: {
    maxResults: 5,
    pinnedCompetitionSlugs: [],
    requiresInternalApproval: true,
    allowsWebVerification: true,
    exposesInternalFields: true,
    oneReportPerEmail: false,
    emailJourney: 'ENROLLED_EXTENSION_5',
    entitlementDriven: true,
    chatKnowledgeScope: 'ACTIVATED_INTERNAL',
    chatTurnLimit: null,
    chatCompetitionExposureCap: null,
  },
};

export function policyFor(persona: Persona): PersonaPolicy {
  return POLICIES[persona];
}

/**
 * Email matching must not fail on formatting. Parents type addresses by hand,
 * and the sheet is edited by humans: `John.Doe+kid@Gmail.com ` and
 * `johndoe@gmail.com` are the same person for roster purposes.
 *
 * Dots are only stripped for Google-hosted domains, where they are genuinely
 * insignificant. Doing it everywhere would collide distinct addresses on
 * providers that treat dots as meaningful.
 */
const DOT_INSENSITIVE_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

export function normalizeEmail(raw: string): string {
  const trimmed = (raw ?? '').trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return trimmed;

  let local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (DOT_INSENSITIVE_DOMAINS.has(domain)) local = local.replaceAll('.', '');

  return `${local}@${domain}`;
}

export interface PersonaResolution {
  persona: Persona;
  /** Why — useful in the internal console and in audit logs. */
  reason:
    | 'ROSTER_STUDENT_EMAIL'
    | 'ROSTER_PARENT_EMAIL'
    | 'NOT_ON_ROSTER'
    | 'ROSTER_UNAVAILABLE';
  rosterEntryId?: string;
  competitionAllowance?: number;
}

/**
 * The single source of truth for which experience a signup gets.
 *
 * Matches on the student email OR the parent email — parents frequently sign up
 * on the student's behalf, and treating that as "not enrolled" would hand a
 * paying family the public lead-capture flow.
 *
 * A roster that is empty because a sync failed must not silently downgrade
 * everyone, so an empty roster resolves to ROSTER_UNAVAILABLE and the caller
 * decides (existing users keep their persona; new signups default to TOF).
 */
export async function resolvePersona(
  prisma: PrismaClient,
  email: string,
): Promise<PersonaResolution> {
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
  });

  if (entry) {
    return {
      persona: 'ENROLLED',
      reason:
        entry.emailNormalized === normalized
          ? 'ROSTER_STUDENT_EMAIL'
          : 'ROSTER_PARENT_EMAIL',
      rosterEntryId: entry.id,
      ...(entry.competitionAllowance != null
        ? { competitionAllowance: entry.competitionAllowance }
        : {}),
    };
  }

  const rosterSize = await prisma.enrolledRosterEntry.count({ where: { active: true } });
  if (rosterSize === 0) {
    return { persona: 'TOF', reason: 'ROSTER_UNAVAILABLE' };
  }

  return { persona: 'TOF', reason: 'NOT_ON_ROSTER' };
}
