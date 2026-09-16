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
import { fallbackPinFor } from './pin-fallback.js';
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

/**
 * Resolve pinned base slugs to the concrete, region-qualified competition each
 * one names — exactly one row per base slug, in the configured order.
 *
 * The pin exists so that CREST is the first card every non-enrolled student
 * sees, and a pin that silently fails to resolve defeats the whole point: the
 * student gets a page of ranked matches with no free sample at the top of it,
 * and nothing in the response says why. So the lookup widens rather than gives
 * up. Exact region and open cycle is what we want; the same competition in the
 * other region, or one whose cycle we have marked closed, is still a better
 * answer than no free sample at all — CREST is a rolling, region-agnostic
 * accreditation, so the "wrong" row is right for the student anyway.
 *
 * Widening is only ever a fallback. It cannot reorder the pins, and picking one
 * row per base slug is load-bearing rather than tidiness: the previous query
 * mapped every matching row straight into the pin list, so a student with no
 * country on file pinned both `crest-awards--in` and `crest-awards--us` and saw
 * the same award twice at the top of their report.
 *
 * `current` is a strong preference here rather than the hard gate it is for
 * ranked candidates, and the difference is deliberate. A pin is a product
 * decision — CREST is the free sample on every public report — so a stale flag
 * on the CREST row should not silently delete the one card the page is built
 * around. Ranked results have no such promise behind them and are gated
 * outright. If this ever needs to become a hard gate too, the fix is to drop
 * `CURRENT` from the ranking below, not to special-case the caller.
 *
 * **The pin is matched by name, not only by an exact slug.** `baseSlug` is
 * `slugify(name)` straight off the masterlist, so `crest-awards` only matches a
 * sheet that happens to spell it "CREST Awards". "CREST Awards (Gold)",
 * "Crest Award" or a reordered title all slugify to something else, and the
 * whole guarantee would then fail silently on a spreadsheet edit nobody thought
 * of as a code change. Matching widens through three tiers of decreasing
 * specificity so a rename degrades instead of disappearing.
 */
const PIN_PREFERENCE = { REGION: 4, CURRENT: 2, CYCLE_ACTIVE: 1 } as const;

/**
 * How closely a row answers to a configured pin. Specificity dominates quality:
 * an exact slug in the wrong region still beats a loose name match in the right
 * one, because the wrong competition first is worse than the right one second.
 */
const PIN_SPECIFICITY = { EXACT: 300, PREFIX: 200, NAME: 100 } as const;

/** `crest-awards` → the distinctive leading word the sheet is unlikely to drop. */
function pinToken(baseSlug: string): string {
  return baseSlug.split('-')[0] || baseSlug;
}

export interface ResolvedPin {
  slug: string;
  name: string;
  /** How it was found — surfaced on the trace so a loose match is visible. */
  matchedBy: 'exact' | 'prefix' | 'name';
}

export async function resolvePins(
  prisma: Pick<PrismaClient, 'competition'>,
  baseSlugs: string[],
  region: Region | null,
): Promise<ResolvedPin[]> {
  if (baseSlugs.length === 0) return [];

  const rows = await prisma.competition.findMany({
    where: {
      OR: baseSlugs.flatMap((baseSlug) => [
        { baseSlug },
        // "crest-awards-gold", "crest-awards-bronze"
        { baseSlug: { startsWith: `${baseSlug}-` } },
        // "CREST Award", "The CREST Awards Scheme"
        { name: { contains: pinToken(baseSlug), mode: 'insensitive' as const } },
      ]),
    },
    select: {
      slug: true,
      baseSlug: true,
      name: true,
      region: true,
      cycleActive: true,
      current: true,
    },
  });

  // Quality, within a specificity tier: the student's own region outranks
  // everything, then a current listing, then an open cycle. Stated once as
  // weights rather than as a chain of fallbacks that has to be re-read.
  const quality = (row: { region: string; cycleActive: boolean; current: boolean }): number =>
    (row.region === region ? PIN_PREFERENCE.REGION : 0) +
    (row.current ? PIN_PREFERENCE.CURRENT : 0) +
    (row.cycleActive ? PIN_PREFERENCE.CYCLE_ACTIVE : 0);

  const specificity = (
    row: { baseSlug: string; name: string },
    baseSlug: string,
  ): { rank: number; matchedBy: ResolvedPin['matchedBy'] } | null => {
    if (row.baseSlug === baseSlug) return { rank: PIN_SPECIFICITY.EXACT, matchedBy: 'exact' };
    if (row.baseSlug.startsWith(`${baseSlug}-`)) {
      return { rank: PIN_SPECIFICITY.PREFIX, matchedBy: 'prefix' };
    }
    if (row.name.toLowerCase().includes(pinToken(baseSlug))) {
      return { rank: PIN_SPECIFICITY.NAME, matchedBy: 'name' };
    }
    return null;
  };

  const resolved: ResolvedPin[] = [];
  const taken = new Set<string>();

  for (const baseSlug of baseSlugs) {
    let best: { row: (typeof rows)[number]; score: number; matchedBy: ResolvedPin['matchedBy'] } | undefined;

    for (const row of rows) {
      // One row can only satisfy one pin, so two pins never collapse onto the
      // same competition and render it twice.
      if (taken.has(row.slug)) continue;

      const match = specificity(row, baseSlug);
      if (!match) continue;

      const score = match.rank + quality(row);
      if (!best || score > best.score) best = { row, score, matchedBy: match.matchedBy };
    }

    if (best) {
      taken.add(best.row.slug);
      resolved.push({ slug: best.row.slug, name: best.row.name, matchedBy: best.matchedBy });
    }
  }

  return resolved;
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
  //
  // The region is re-applied here rather than trusted from the Chroma hit. Slugs
  // are region-qualified, so in a consistent pair of stores this changes nothing
  // — but Chroma's region tag is the derived copy, and if it drifts from the
  // Postgres row (a re-ingest with different tags, a partial re-seed) this is the
  // filter that still holds. Both stores are scoped, so neither alone decides.
  //
  // `current` is the masterlist-update flag: true only for competitions on the
  // live sheet. Nothing may be recommended without it — an old row carries
  // deadlines and eligibility we have stopped standing behind, and presenting
  // one to a family is worse than returning a shorter list.
  //
  // It is enforced here and not in Chroma on purpose. `build_metadata` in the
  // ingest does not write `current` into the document metadata, so a Chroma
  // `where` on it would match nothing at all rather than narrowing. Postgres is
  // the authoritative row and the only store that actually knows the answer.
  const competitions = await prisma.competition.findMany({
    where: {
      slug: { in: hits.map((h) => h.slug) },
      ...(region ? { region } : {}),
      current: true,
    },
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
  // for this student's region.
  const resolvedPins = await resolvePins(prisma, policy.pinnedCompetitionSlugs, region);
  const resolvedBaseSlugs = new Set(
    policy.pinnedCompetitionSlugs.filter((base) =>
      resolvedPins.some((pin) => pin.slug === base || pin.slug.startsWith(`${base}--`)),
    ),
  );

  // A pin the repository cannot answer falls back to the built-in card rather
  // than vanishing. CREST leading the page is a promise to the student; a row
  // missing from the masterlist is our problem, not something they should see
  // the consequences of. The run still warns, so the data gets fixed.
  const fallbackPins = policy.pinnedCompetitionSlugs.filter(
    (base) => !resolvedBaseSlugs.has(base) && fallbackPinFor(base),
  );

  const { items } = applyPolicy({
    ranked: reranked.ranked,
    policy,
    // Order is preserved: each configured pin contributes either its resolved
    // row or its fallback, never both.
    pinnedSlugs: policy.pinnedCompetitionSlugs.flatMap((base) => {
      const resolved = resolvedPins.find(
        (pin) => pin.slug === base || pin.slug.startsWith(`${base}--`),
      );
      if (resolved) return [resolved.slug];
      return fallbackPinFor(base) ? [base] : [];
    }),
  });

  // Genuinely unserved: no row and no built-in card either.
  const unresolvedPins = policy.pinnedCompetitionSlugs.filter(
    (base) => !resolvedBaseSlugs.has(base) && !fallbackPinFor(base),
  );

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
      //
      // A pin with no row falls back to its built-in card. That card is already
      // in the public shape — it carries no internal fields to leak, so it is
      // safe for either persona.
      competition: competition
        ? policy.exposesInternalFields
          ? toInternalDto(competition)
          : toPublicDto(competition)
        : (fallbackPinFor(item.slug) ?? null),
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
    // Which row each pin actually landed on, and how loosely it matched. A
    // `matchedBy` of "name" means the masterlist no longer spells the pin the
    // way the policy does — still correct, but worth a look before the next
    // rename turns it into an unresolved pin.
    resolvedPins,
    // Pins served from the built-in card because the repository had no row.
    // The student saw the competition; the data is still wrong.
    fallbackPins,
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
      // Two very different failures both land here, and telling them apart is
      // worth one extra query on a path that has already produced nothing. The
      // rows may be absent (the stores are out of sync), or present but all
      // `current = false` — which is not a sync problem at all and would send
      // someone re-running the seed for no reason.
      const presentButNotCurrent = await prisma.competition.count({
        where: { slug: { in: hits.map((h) => h.slug) }, ...(region ? { region } : {}) },
      });
      warning =
        presentButNotCurrent > 0
          ? `All ${presentButNotCurrent} retrieved competitions are flagged current = false, so none may be recommended. ` +
            `The masterlist backfill that sets this flag has probably not been run against these rows.`
          : `Chroma returned ${hits.length} matches but none exist in Postgres — the two stores are out of sync. ` +
            `Run: npm run seed:competitions -- ../data/competitions.normalized.json ` +
            `(example id: ${hits[0]?.slug}).`;
    } else if (eligible.length === 0) {
      warning = `All ${dropped.length} retrieved competitions failed eligibility for this student.`;
    } else {
      warning = `${eligible.length} competitions were eligible but the ranking step returned none.`;
    }
  } else if (unresolvedPins.length > 0) {
    // A pin that does not resolve is the one failure this pipeline used to keep
    // to itself: the run looks healthy, the student just never sees the free
    // sample the whole public flow is built around. Now it surfaces on the run
    // and in the logs, because the fix is a data change nobody will make while
    // it stays silent.
    warning =
      `Pinned competition${unresolvedPins.length > 1 ? 's' : ''} ${unresolvedPins.join(', ')} ` +
      `did not resolve to any row and has no built-in card, so this report does not lead with it. ` +
      `The masterlist has no competition whose slug or name matches — check how it is spelled there.`;
  } else if (fallbackPins.length > 0) {
    // The student is fine — they saw the card. This is addressed to whoever
    // maintains the repository, because a built-in card cannot carry the
    // deadlines, eligibility or scores a real row would.
    warning =
      `Pinned competition${fallbackPins.length > 1 ? 's' : ''} ${fallbackPins.join(', ')} ` +
      `had no row in the repository, so the built-in card was served instead. ` +
      `The report leads with it as intended, but it carries no deadline, eligibility or scores — ` +
      `re-seed the masterlist so the real listing supersedes it.`;
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
