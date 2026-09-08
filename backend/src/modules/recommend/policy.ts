/**
 * Stage 5 — apply the persona policy to a ranked list.
 *
 * Pure and separately testable, because this is where the two products actually
 * differ: how many results, what is pinned, and whether a human sees it first.
 */

import type { PersonaPolicy } from '../../lib/persona.js';
import type { RankedItem } from './rerank.js';

export interface PolicyInput {
  ranked: RankedItem[];
  policy: PersonaPolicy;
  /**
   * Slug of each pinned competition that exists for this student's region,
   * resolved from `policy.pinnedCompetitionSlugs` (base slugs) by the caller.
   */
  pinnedSlugs: string[];
}

export interface PolicyOutput {
  /**
   * `ranked` is false for a pin the model never scored. Its `score` is a
   * placeholder, not a judgement — rendering it as "0% fit" tells a student the
   * free sample is a terrible match, which is the opposite of the intent.
   */
  items: (RankedItem & { pinned: boolean; ranked: boolean })[];
  /** Names of pins that could not be resolved for this region. */
  unresolvedPins: string[];
}

/**
 * CREST is the free sample on the public matcher and must be the first visible
 * result for every TOF user. It is pinned rather than ranked, so a weak semantic
 * match never pushes it down or out of the list.
 *
 * If a pinned competition was also ranked by the model, its reason is kept — a
 * real, project-specific reason beats a generic pinned one.
 */
export function applyPolicy(input: PolicyInput): PolicyOutput {
  const { ranked, policy, pinnedSlugs } = input;

  const byslug = new Map(ranked.map((item) => [item.slug, item]));
  const pinnedItems: (RankedItem & { pinned: boolean; ranked: boolean })[] = [];

  for (const slug of pinnedSlugs) {
    const existing = byslug.get(slug);
    pinnedItems.push(
      existing
        ? { ...existing, pinned: true, ranked: true }
        : {
            slug,
            score: 0,
            ranked: false,
            reason:
              'Included for every student as a starting point: an accredited project award you can enter with work you already have.',
            fitBucket: 'SAFETY',
            pinned: true,
          },
    );
  }

  const pinnedSet = new Set(pinnedSlugs);
  const rest = ranked
    .filter((item) => !pinnedSet.has(item.slug))
    .map((item) => ({ ...item, pinned: false, ranked: true }));

  // The cap counts pinned entries: "5-8 competitions" is the whole report, not
  // the report plus extras.
  const items = [...pinnedItems, ...rest].slice(0, policy.maxResults);

  const unresolvedPins = policy.pinnedCompetitionSlugs.filter(
    (base) => !pinnedSlugs.some((slug) => slug.startsWith(`${base}--`) || slug === base),
  );

  return { items, unresolvedPins };
}
