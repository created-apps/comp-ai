/**
 * Built-in pin fallbacks.
 *
 * A pin is a product promise: CREST is the first card every non-enrolled student
 * sees, whatever their project. `resolvePins` keeps that promise by widening its
 * search across region, cycle and spelling — but it can only return a row that
 * exists. If the masterlist has no CREST row at all (never ingested, dropped in
 * a re-seed, renamed past even the loose name match), the promise breaks and the
 * student gets a report that does not lead with the free sample.
 *
 * This is the floor under that. When a pin resolves to nothing, the pipeline
 * serves the entry below instead, so the card is always there.
 *
 * Two things follow from a fallback having no database row, and both are
 * deliberate:
 *
 *  - **It is never persisted as a normalized RecommendationItem.** Those rows
 *    carry a foreign key to Competition, and there is nothing to point at. It
 *    lives in the run's jsonb payload only, which is what the student and the
 *    emailed report actually read.
 *  - **It is TOF-only in practice.** Pins are a TOF policy, and selection,
 *    activation and the COSMIC assignment push are all ENROLLED-only and refuse
 *    a TOF account outright — so nothing downstream ever tries to resolve this
 *    slug to a competition id.
 *
 * Serving this is still a signal that the repository is wrong: the pipeline
 * warns on the run whenever it has to. The database is meant to be the source
 * of truth, and a real row supersedes this the moment one exists.
 *
 * The content is deliberately conservative. Everything here is either stable
 * fact about the scheme or taken from the masterlist's own CREST row; anything
 * that varies by cycle or region — deadlines, grade bounds, selectivity — is
 * left null rather than asserted, because the whole point of the eligibility and
 * reranking rules elsewhere is that we never claim what we have not verified.
 */

import type { PublicCompetitionDto } from '../competitions/dto.js';

/**
 * Keyed by the region-free base slug configured in `PersonaPolicy`. The DTO's
 * own `slug` is that same base slug, which cannot collide with a real row:
 * ingested slugs are always region-qualified (`crest-awards--in`).
 */
export const PIN_FALLBACKS: Record<string, PublicCompetitionDto> = {
  'crest-awards': {
    slug: 'crest-awards',
    name: 'CREST Awards',
    description:
      'The British Science Association’s project award scheme. You enter work you have ' +
      'already done — an investigation, a build or a written study — and it is assessed ' +
      'at Bronze, Silver or Gold depending on the depth of the project.',
    domains: ['stem'],
    regions: [],
    // Left unstated on purpose: the award level determines what is expected, and
    // the masterlist row is where those specifics belong.
    eligibility: null,
    team: null,
    deadline: {
      date: null,
      text: 'Rolling — there is no single closing date.',
      precision: 'ROLLING',
      isRolling: true,
      lastVerifiedAt: null,
    },
    registrationStatus: null,
    officialUrl: 'https://www.crestawards.org',
    // Not scored: inventing a prestige or selectivity number here would be the
    // exact failure the reranker's "never assert what is not in the data" rule
    // exists to prevent.
    prestige: null,
    selectivity: null,
    difficulty: null,
  },
};

/** The built-in card for a pin that resolved to nothing, if there is one. */
export function fallbackPinFor(baseSlug: string): PublicCompetitionDto | undefined {
  return PIN_FALLBACKS[baseSlug];
}
