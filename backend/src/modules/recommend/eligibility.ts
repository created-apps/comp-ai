/**
 * Hard eligibility filtering.
 *
 * This runs in the application against authoritative Postgres rows, after Chroma
 * has generated candidates. Chroma narrows, this decides — a semantic match that
 * a student cannot enter is not a match at all, and must be dropped rather than
 * ranked lower.
 *
 * The governing rule for this dataset: **unknown is not a disqualifier.** Large
 * parts of the masterlist are blank (114 of 205 India rows have no Subject/Domain,
 * most rows have no official URL, many have no grade range). Treating a missing
 * grade range as "fails the grade check" would silently delete most of the
 * repository. So a filter only rejects when the data is present *and* violated,
 * and everything it could not check is reported back so the reason string can say
 * "eligibility not stated" instead of implying it was verified.
 */

import type { Competition } from '@prisma/client';

export interface StudentContext {
  /** School grade, if known. */
  grade?: number | null;
  age?: number | null;
  /** "India" | "USA" — normally already applied at retrieval time. */
  region?: string | null;
  /** Intended team size; 1 means solo. */
  teamSize?: number | null;
  /** Defaults to now; injectable so tests are not time-dependent. */
  now?: Date;
}

export type RejectionCode =
  | 'NO_CONTENT'
  | 'CYCLE_INACTIVE'
  | 'DEADLINE_PASSED'
  | 'REGION_MISMATCH'
  | 'GRADE_BELOW_MIN'
  | 'GRADE_ABOVE_MAX'
  | 'AGE_BELOW_MIN'
  | 'AGE_ABOVE_MAX'
  | 'TEAM_TOO_SMALL'
  | 'TEAM_TOO_LARGE'
  | 'SOLO_NOT_ALLOWED'
  | 'TEAM_NOT_ALLOWED';

export interface EligibilityResult {
  eligible: boolean;
  rejections: { code: RejectionCode; detail: string }[];
  /** Checks that could not run because the sheet has no value for them. */
  unverified: string[];
}

export function checkEligibility(
  competition: Competition,
  student: StudentContext,
): EligibilityResult {
  const rejections: EligibilityResult['rejections'] = [];
  const unverified: string[] = [];
  const now = student.now ?? new Date();

  // A row with nothing but a name cannot be recommended. Its embedded document
  // is close to noise, so it surfaces against almost any query, and there is no
  // basis on which to tell a student why it fits — the reranker can only produce
  // a caveat dressed up as a recommendation.
  if (!competition.description && !competition.submissionDetails && competition.domains.length === 0) {
    rejections.push({
      code: 'NO_CONTENT',
      detail: 'the masterlist row has no description, submission details or subject',
    });
  }

  if (!competition.cycleActive) {
    rejections.push({ code: 'CYCLE_INACTIVE', detail: 'this cycle is closed' });
  }

  // Only a full, day-precision date can retire a competition. A month-precision
  // or rolling deadline stays in play — dropping "March 2026" on 2 March would
  // remove a competition that is very likely still open.
  if (
    competition.deadlineDate &&
    competition.deadlinePrecision === 'DAY' &&
    competition.deadlineDate.getTime() < now.getTime()
  ) {
    rejections.push({
      code: 'DEADLINE_PASSED',
      detail: `deadline was ${competition.deadlineDate.toISOString().slice(0, 10)}`,
    });
  } else if (!competition.deadlineDate && !competition.isRolling) {
    unverified.push('deadline not stated in the masterlist');
  }

  if (student.region && competition.region && student.region !== competition.region) {
    rejections.push({
      code: 'REGION_MISMATCH',
      detail: `listed for ${competition.region}, student is in ${student.region}`,
    });
  }

  // --- grade ---
  if (student.grade != null) {
    if (competition.gradeMin != null && student.grade < competition.gradeMin) {
      rejections.push({
        code: 'GRADE_BELOW_MIN',
        detail: `grade ${student.grade} is below the minimum of ${competition.gradeMin}`,
      });
    }
    if (competition.gradeMax != null && student.grade > competition.gradeMax) {
      rejections.push({
        code: 'GRADE_ABOVE_MAX',
        detail: `grade ${student.grade} is above the maximum of ${competition.gradeMax}`,
      });
    }
    if (competition.gradeMin == null && competition.gradeMax == null) {
      unverified.push('no grade range in the masterlist');
    }
  }

  // --- age ---
  if (student.age != null) {
    if (competition.ageMin != null && student.age < competition.ageMin) {
      rejections.push({
        code: 'AGE_BELOW_MIN',
        detail: `age ${student.age} is below the minimum of ${competition.ageMin}`,
      });
    }
    if (competition.ageMax != null && student.age > competition.ageMax) {
      rejections.push({
        code: 'AGE_ABOVE_MAX',
        detail: `age ${student.age} is above the maximum of ${competition.ageMax}`,
      });
    }
  }

  // --- team size ---
  const teamSize = student.teamSize ?? null;
  if (teamSize != null) {
    if (teamSize === 1 && competition.allowsIndividual === false) {
      rejections.push({ code: 'SOLO_NOT_ALLOWED', detail: 'entries must be teams' });
    }
    if (teamSize > 1 && competition.allowsTeam === false) {
      rejections.push({ code: 'TEAM_NOT_ALLOWED', detail: 'entries must be individual' });
    }
    if (competition.teamMin != null && teamSize < competition.teamMin) {
      rejections.push({
        code: 'TEAM_TOO_SMALL',
        detail: `team of ${teamSize} is below the minimum of ${competition.teamMin}`,
      });
    }
    if (competition.teamMax != null && teamSize > competition.teamMax) {
      rejections.push({
        code: 'TEAM_TOO_LARGE',
        detail: `team of ${teamSize} exceeds the maximum of ${competition.teamMax}`,
      });
    }
  }

  return { eligible: rejections.length === 0, rejections, unverified };
}

/** Convenience: partition candidates into kept and dropped, keeping the reason. */
export function partitionEligible(
  competitions: Competition[],
  student: StudentContext,
): {
  eligible: { competition: Competition; result: EligibilityResult }[];
  dropped: { slug: string; name: string; rejections: EligibilityResult['rejections'] }[];
} {
  const eligible: { competition: Competition; result: EligibilityResult }[] = [];
  const dropped: { slug: string; name: string; rejections: EligibilityResult['rejections'] }[] = [];

  for (const competition of competitions) {
    const result = checkEligibility(competition, student);
    if (result.eligible) eligible.push({ competition, result });
    else dropped.push({ slug: competition.slug, name: competition.name, rejections: result.rejections });
  }

  return { eligible, dropped };
}
