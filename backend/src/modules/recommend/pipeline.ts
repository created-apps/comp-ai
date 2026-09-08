/**
 * The recommendation pipeline.
 *
 *   classify → retrieve (region-scoped) → hard filter (SQL) → rerank (id-constrained)
 *   → apply persona policy → persist as jsonb + normalized items
 *
 * One code path produces every recommendation in the product. The TOF matcher and
 * the Enrolled Competition OS differ only in the PersonaPolicy passed in, so a
 * change to ranking quality lands in both at once and cannot drift apart.
 */

import { createHash } from 'node:crypto';
import type { Persona, PrismaClient, Prisma } from '@prisma/client';
import { ENGINE_VERSION, MODEL } from '../../lib/claude.js';
import { policyFor, type PersonaPolicy } from '../../lib/persona.js';
import { regionForCountry, searchCompetitions, type Region } from '../retrieval/chroma.js';
import { classifyProject, type Classification } from './classify.js';
import { partitionEligible, type StudentContext } from './eligibility.js';
import { applyPolicy } from './policy.js';
import { rerankCandidates, type RerankCandidate } from './rerank.js';
import { toPublicDto, toInternalDto } from '../competitions/dto.js';
import { notifyReviewers } from '../email/notify-review.js';

/** Over-fetch from Chroma; hard filters will remove a large share of these. */
const CANDIDATE_POOL = 30;

export interface GenerateInput {
  projectId: string;
  persona: Persona;
  student: StudentContext & { country?: string | null };
  /** Overrides the persona default; still clamped by the policy cap. */
  limit?: number;
  /** Recompute the stored classification — use after the project text changes. */
  reclassify?: boolean;
  /** A reviewer's rejection note, fed to the ranker as a correction. */
  reviewerGuidance?: string;
}

export interface GenerateResult {
  runId: string;
  status: 'PENDING_REVIEW' | 'DRAFT';
  itemCount: number;
  /** Present when the pipeline produced nothing useful, for the caller to surface. */
  warning?: string;
}

export async function generateRecommendations(
  prisma: PrismaClient,
  input: GenerateInput,
): Promise<GenerateResult> {
  const policy: PersonaPolicy = policyFor(input.persona);
  const startedAt = Date.now();

  const project = await prisma.project.findUnique({ where: { id: input.projectId } });
  if (!project) throw new Error(`project ${input.projectId} not found`);

  // --- 1. classify -------------------------------------------------------
  // Reused once computed. The classification produces `searchQuery`, and a
  // freshly worded query each run retrieves a different candidate set — which is
  // why the same project used to yield a different list every time. Retrieval
  // itself is deterministic (same text -> same vectors -> same neighbours), so
  // pinning the query pins the candidates.
  const cached = project.classification as Classification & { engineVersion?: string } | null;
  const reuseClassification =
    !input.reclassify && cached?.searchQuery && cached.engineVersion === ENGINE_VERSION;

  const classification: Classification = reuseClassification
    ? cached
    : await classifyProject({ domain: project.domain, description: project.description });

  if (!reuseClassification) {
    await prisma.project.update({
      where: { id: project.id },
      data: {
        classification: {
          ...classification,
          engineVersion: ENGINE_VERSION,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // --- 2. retrieve -------------------------------------------------------
  const region: Region | null =
    regionForCountry(input.student.country) ??
    (input.student.region === 'India' || input.student.region === 'USA'
      ? input.student.region
      : null);

  const hits = await searchCompetitions({
    query: classification.searchQuery,
    region,
    limit: CANDIDATE_POOL,
  });

  // --- 3. hard filter, against authoritative Postgres rows ----------------
  // Chroma metadata is a derived copy and can lag a re-seed; eligibility is
  // always decided on the database row.
  const competitions = await prisma.competition.findMany({
    where: { slug: { in: hits.map((h) => h.slug) } },
  });

  const scoreBySlug = new Map(hits.map((h) => [h.slug, h.score]));
  const { eligible, dropped } = partitionEligible(competitions, {
    ...input.student,
    ...(region ? { region } : {}),
  });

  const candidates: RerankCandidate[] = eligible
    .map(({ competition, result }) => ({
      competition,
      retrievalScore: scoreBySlug.get(competition.slug) ?? 0,
      eligibility: result,
    }))
    .sort((a, b) => b.retrievalScore - a.retrievalScore);

  // --- 4. rerank ---------------------------------------------------------
  const limit = Math.min(input.limit ?? policy.maxResults, policy.maxResults);
  const reranked = await rerankCandidates({
    classification,
    projectDescription: project.description,
    candidates,
    limit,
    ...(input.reviewerGuidance ? { reviewerGuidance: input.reviewerGuidance } : {}),
  });

  // --- 5. policy ---------------------------------------------------------
  // Pins are configured as region-free base slugs; resolve them to the document
  // that exists for this student's region, if any.
  const pinnedSlugs =
    policy.pinnedCompetitionSlugs.length > 0
      ? (
          await prisma.competition.findMany({
            where: {
              baseSlug: { in: policy.pinnedCompetitionSlugs },
              ...(region ? { region } : {}),
              cycleActive: true,
            },
            select: { slug: true },
          })
        ).map((c) => c.slug)
      : [];

  const { items, unresolvedPins } = applyPolicy({
    ranked: reranked.ranked,
    policy,
    pinnedSlugs,
  });

  // --- 6. persist --------------------------------------------------------
  const competitionBySlug = new Map(competitions.map((c) => [c.slug, c]));
  const pinnedOnly = await prisma.competition.findMany({
    where: { slug: { in: items.map((i) => i.slug).filter((s) => !competitionBySlug.has(s)) } },
  });
  for (const c of pinnedOnly) competitionBySlug.set(c.slug, c);

  const payloadItems = items.map((item, index) => {
    const competition = competitionBySlug.get(item.slug);
    return {
      rank: index + 1,
      slug: item.slug,
      score: item.score,
      reason: item.reason,
      fitBucket: item.fitBucket,
      pinned: item.pinned,
      // False for a pin the model never scored — the UI must not render a fit
      // percentage for it.
      ranked: item.ranked,
      ...(item.ranked ? {} : { score: null }),
      // The competition is snapshotted through the persona's serializer, so the
      // stored payload can never contain a field that persona may not see.
      competition: competition
        ? policy.exposesInternalFields
          ? toInternalDto(competition)
          : toPublicDto(competition)
        : null,
    };
  });

  const payload = {
    engineVersion: ENGINE_VERSION,
    model: MODEL,
    persona: input.persona,
    generatedAt: new Date().toISOString(),
    classification,
    region,
    items: payloadItems,
    reviewerNotes: reranked.notes ?? null,
  };

  const retrievalTrace = {
    query: classification.searchQuery,
    region,
    domains: classification.domains,
    retrieved: hits.map((h) => ({ slug: h.slug, score: h.score })),
    candidatePool: CANDIDATE_POOL,
    classificationReused: reuseClassification,
    eligibleCount: eligible.length,
    droppedByHardFilter: dropped,
    // Kept deliberately: a rising count here is the signal that a prompt or model
    // change has started producing ids outside the repository.
    hallucinatedIds: reranked.hallucinatedIds,
    // Weak matches the model returned but that were not worth showing.
    belowScoreFloor: reranked.belowFloor,
    unresolvedPins,
    ...(input.reviewerGuidance ? { reviewerGuidance: input.reviewerGuidance } : {}),
    durationMs: Date.now() - startedAt,
  };

  const status = policy.requiresInternalApproval ? 'PENDING_REVIEW' : 'DRAFT';
  const promptHash = createHash('sha256')
    .update(`${ENGINE_VERSION} ${MODEL} ${project.description}`)
    .digest('hex');

  const run = await prisma.recommendationRun.create({
    data: {
      projectId: project.id,
      persona: input.persona,
      status,
      payload: payload as unknown as Prisma.InputJsonValue,
      retrievalTrace: retrievalTrace as unknown as Prisma.InputJsonValue,
      engineVersion: ENGINE_VERSION,
      modelId: MODEL,
      promptHash,
      items: {
        create: payloadItems
          .filter((item) => competitionBySlug.has(item.slug))
          .map((item) => ({
            competitionId: competitionBySlug.get(item.slug)!.id,
            rank: item.rank,
            // The normalized row keeps a numeric score for querying; the payload
            // is where an unranked pin reads as "no score", not as zero.
            score: item.score ?? 0,
            reason: item.reason,
            fitBucket: item.fitBucket,
            detail: item as unknown as Prisma.InputJsonValue,
          })),
      },
    },
    select: { id: true },
  });

  // Three very different failures used to share one message. `competitions` is
  // the Postgres lookup, not the Chroma result, so an unseeded database reported
  // itself as a Chroma problem and sent you looking in the wrong place.
  // A review queue nobody is told about is a queue nobody opens — and the
  // student is left on "your matches are with the CreatED team" meanwhile.
  // Non-fatal: failing to notify must not fail the generation.
  if (status === 'PENDING_REVIEW' && payloadItems.length > 0) {
    await notifyReviewers(prisma, run.id).catch(() => undefined);
  }

  let warning: string | undefined;
  if (payloadItems.length === 0) {
    if (hits.length === 0) {
      warning = region
        ? `Chroma returned nothing for region "${region}". Check the collection is populated and that its region tags are "India"/"USA".`
        : 'Chroma returned nothing. Check CHROMA_COLLECTION matches what the ingest wrote.';
    } else if (competitions.length === 0) {
      warning =
        `Chroma returned ${hits.length} matches but none exist in Postgres — the two stores are out of sync. ` +
        `Run: npm run seed:competitions -- ../data/competitions.normalized.json ` +
        `(example id: ${hits[0]?.slug}).`;
    } else if (eligible.length === 0) {
      warning = `All ${dropped.length} retrieved competitions failed eligibility for this student.`;
    } else {
      warning = `${eligible.length} competitions were eligible but the ranking step returned none.`;
    }
  } else if (reranked.hallucinatedIds.length > 0) {
    warning = `${reranked.hallucinatedIds.length} invented ids were discarded before saving.`;
  }

  return {
    runId: run.id,
    status,
    itemCount: payloadItems.length,
    ...(warning ? { warning } : {}),
  };
}
