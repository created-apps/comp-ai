/**
 * Stage 4 — rank the eligible candidates.
 *
 * The model sees an id-keyed list of competitions that have already passed hard
 * eligibility, and returns an ordering with a reason for each. Two guarantees
 * matter more than the ranking quality itself:
 *
 *  1. **It cannot invent a competition.** The model returns ids; any id outside
 *     the candidate set is discarded here, in code, before persistence. A prompt
 *     instruction alone would not be a guarantee.
 *  2. **It cannot silently upgrade missing data.** Most rows have no prestige or
 *     selectivity score, so the prompt states which fields are absent and the
 *     reason must not claim a competition is "highly selective" without evidence.
 */

import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Competition } from '@prisma/client';
import { assertNotRefused, getClaude, MODEL } from '../../lib/claude.js';
import { clampNumber, clampText } from '../../lib/clamp.js';
import type { Classification } from './classify.js';
import type { EligibilityResult } from './eligibility.js';

/** Display limits, applied after parsing rather than as schema constraints. */
const REASON_MAX = 320;
const NOTES_MAX = 500;

/**
 * Below this, a result is noise dressed as a recommendation. A student reading
 * "20% fit — fit cannot be verified" learns nothing and trusts the list less;
 * three real matches beat eight with five apologies among them.
 */
const MIN_SCORE = 35;

/**
 * Shape only — no length or range limits. Those are enforced after parsing (see
 * lib/clamp.ts); expressing them here would turn a slightly long sentence into a
 * failed run.
 */
const rankedItemSchema = z.object({
  slug: z.string().describe('The exact competition id from the candidate list.'),
  score: z.number().describe('Fit for THIS project, 0-100.'),
  reason: z
    .string()
    .describe(
      'One or two sentences (max ~300 characters) on why this competition fits this specific project. Reference the project, not generic praise.',
    ),
  fitBucket: z
    .enum(['REACH', 'TARGET', 'SAFETY'])
    .describe(
      'REACH: strong work may still not advance. TARGET: good fit with the judging criteria. SAFETY: well-developed work has a comparatively strong chance.',
    ),
});

const rerankSchema = z.object({
  ranked: z.array(rankedItemSchema),
  /** Surfaced to the internal reviewer, not to students. */
  notes: z.string().optional(),
});

export interface RerankCandidate {
  competition: Competition;
  /** Cosine similarity from retrieval, for context only. */
  retrievalScore: number;
  eligibility: EligibilityResult;
}

export interface RankedItem {
  slug: string;
  score: number;
  reason: string;
  fitBucket: 'REACH' | 'TARGET' | 'SAFETY';
}

export interface RerankResult {
  ranked: RankedItem[];
  notes: string | undefined;
  /** Ids the model returned that were not in the candidate set — always dropped. */
  hallucinatedIds: string[];
  /** Ids dropped for scoring below the usefulness floor. */
  belowFloor: { slug: string; score: number }[];
}

const SYSTEM = `You rank competitions for a specific student project. You are the final judgement step in a matching pipeline.

Absolute rules:
- Only ever return ids from the candidate list you are given. Never invent, rename or merge competitions.
- Every candidate has already passed eligibility checks. Do not re-litigate eligibility; rank on fit.
- Many candidates have missing data (no prestige score, no deadline, no stated eligibility). Never assert a fact that is not in the candidate's text. If a competition looks promising but is thinly described, say so plainly in the reason.
- Reasons must be specific to this project. "Great opportunity for STEM students" is useless; name the thing about this project that fits this competition.
- If you cannot say concretely why a competition fits THIS project, omit it. Do not include a competition and then caveat it — a recommendation you have to apologise for is worse than a shorter list.
- Rank on: domain fit, project-type fit, whether the project's maturity matches what the competition expects, and effort against the time available.
- It is correct to return fewer competitions than asked for if the rest are poor fits. Do not pad the list.`;

function candidateBlock(candidate: RerankCandidate): string {
  const c = candidate.competition;
  const missing: string[] = [];
  if (c.prestige == null) missing.push('prestige');
  if (c.selectivity == null) missing.push('selectivity');
  if (c.complexity == null) missing.push('complexity');
  if (c.timeInvestment == null) missing.push('time investment');
  if (!c.deadlineDate && !c.isRolling) missing.push('deadline');
  if (c.domains.length === 0) missing.push('subject/domain');

  const scored = [
    c.prestige != null ? `prestige ${c.prestige}/5` : null,
    c.selectivity != null ? `selectivity ${c.selectivity}/5` : null,
    c.complexity != null ? `complexity ${c.complexity}/5` : null,
    c.timeInvestment != null ? `time investment ${c.timeInvestment}/5` : null,
  ].filter(Boolean);

  return [
    `id: ${c.slug}`,
    `name: ${c.name}`,
    `region: ${c.region}`,
    c.description ? `about: ${c.description}` : null,
    c.submissionDetails ? `submission: ${c.submissionDetails}` : null,
    c.domains.length > 0 ? `domains: ${c.domains.join(', ')}` : null,
    c.eligibilityRaw ? `eligibility: ${c.eligibilityRaw}` : null,
    c.teamRaw ? `team: ${c.teamRaw}` : null,
    c.deadlineText ? `deadline: ${c.deadlineText}` : c.isRolling ? 'deadline: rolling' : null,
    scored.length > 0 ? `scores: ${scored.join(', ')}` : null,
    c.difficulty ? `difficulty: ${c.difficulty}` : null,
    missing.length > 0 ? `NOT RECORDED: ${missing.join(', ')}` : null,
    candidate.eligibility.unverified.length > 0
      ? `UNVERIFIED: ${candidate.eligibility.unverified.join('; ')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function rerankCandidates(input: {
  classification: Classification;
  projectDescription: string;
  candidates: RerankCandidate[];
  /** How many to return. The model may return fewer. */
  limit: number;
  /**
   * A reviewer's note from a rejected run. Regenerating without it would
   * produce the same list and the same rejection.
   */
  reviewerGuidance?: string;
}): Promise<RerankResult> {
  if (input.candidates.length === 0) {
    return { ranked: [], notes: undefined, hallucinatedIds: [], belowFloor: [] };
  }

  const client = getClaude();
  const allowed = new Set(input.candidates.map((c) => c.competition.slug));

  const message = await client.messages.parse({
    model: MODEL,
    max_tokens: 8192,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    // This is the step whose quality a student actually feels — worth the spend.
    output_config: {
      effort: 'high',
      format: zodOutputFormat(rerankSchema),
    },
    messages: [
      {
        role: 'user',
        content: `PROJECT
${input.projectDescription}

Classified as: ${input.classification.domains.join(', ')} · ${input.classification.projectType} · maturity ${input.classification.maturity}

CANDIDATES (${input.candidates.length})
${input.candidates.map(candidateBlock).join('\n\n---\n\n')}
${
  input.reviewerGuidance
    ? `\nA CreatED reviewer rejected the previous set for this project with this note. Treat it as a correction and follow it:\n"${input.reviewerGuidance}"\n`
    : ''
}
Return at most ${input.limit} competitions, best fit first. Fewer is fine if the rest are weak fits.`,
      },
    ],
  });

  assertNotRefused(message);

  const parsed = message.parsed_output;
  if (!parsed) throw new Error('rerank returned no structured output');

  // The anti-hallucination guarantee: enforced here, not in the prompt.
  const hallucinatedIds: string[] = [];
  const belowFloor: { slug: string; score: number }[] = [];
  const ranked: RankedItem[] = [];
  const seen = new Set<string>();

  for (const item of parsed.ranked) {
    if (!allowed.has(item.slug)) {
      hallucinatedIds.push(item.slug);
      continue;
    }
    if (seen.has(item.slug)) continue;
    seen.add(item.slug);

    const score = clampNumber(item.score, 0, 100);
    if (score < MIN_SCORE) {
      belowFloor.push({ slug: item.slug, score });
      continue;
    }

    ranked.push({ ...item, score, reason: clampText(item.reason, REASON_MAX) });
  }

  return {
    ranked: ranked.slice(0, input.limit),
    notes: parsed.notes ? clampText(parsed.notes, NOTES_MAX) : undefined,
    hallucinatedIds,
    belowFloor,
  };
}
