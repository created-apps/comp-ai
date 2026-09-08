/**
 * The two email sequences, as specified in "Competition AI email flows".
 *
 * Only timing and identity live here — the copy lives in the email worker, which
 * is the service that renders and sends. The backend decides *who* gets *what,
 * when*; the worker decides how it looks.
 *
 * Note the day ordering in Flow 2: the source document lists the emails as
 * 1, 2, 3, 4, 5 but their stated timings are Day 1, 9, 6, 3, 13. Sending them in
 * document order would deliver Day 9 before Day 3, so steps are ordered by the
 * day they are actually due and keep their original document number for
 * traceability.
 */

import type { Journey } from './contract.js';

export interface JourneyStep {
  /** Position in send order, 1-based. This is what the worker templates key on. */
  step: number;
  /** The email's number in the source document, where that differs. */
  sourceEmail: number;
  /** Days after enrolment in the journey. */
  day: number;
  label: string;
}

/** Flow 1 — non-enrolled leads. Eight emails, every three days. */
export const TOF_NURTURE_8: JourneyStep[] = [
  { step: 1, sourceEmail: 1, day: 1, label: 'Why competitions matter' },
  { step: 2, sourceEmail: 2, day: 3, label: 'What actually wins' },
  { step: 3, sourceEmail: 3, day: 6, label: 'CreatED competition track record' },
  { step: 4, sourceEmail: 4, day: 9, label: 'Reach, target and safety' },
  { step: 5, sourceEmail: 5, day: 12, label: 'Can you apply with just an idea?' },
  { step: 6, sourceEmail: 6, day: 15, label: 'One project, multiple competitions' },
  { step: 7, sourceEmail: 7, day: 18, label: 'What could this become?' },
  { step: 8, sourceEmail: 8, day: 21, label: 'Final conversion' },
];

/** Flow 2 — existing CreatED families. Five emails, ordered by their real timing. */
export const ENROLLED_EXTENSION_5: JourneyStep[] = [
  { step: 1, sourceEmail: 1, day: 1, label: 'Personalised extension pathways' },
  { step: 2, sourceEmail: 4, day: 3, label: 'What actually wins' },
  { step: 3, sourceEmail: 3, day: 6, label: 'Where CreatED projects have gone' },
  // The one that merges the student's three saved competitions.
  { step: 4, sourceEmail: 2, day: 9, label: 'Your specific competition targets' },
  { step: 5, sourceEmail: 5, day: 13, label: 'Final competition mastery CTA' },
];

/** Not a sequence: one notification, sent the moment a run needs review. */
export const INTERNAL_REVIEW: JourneyStep[] = [
  { step: 1, sourceEmail: 0, day: 0, label: 'Recommendations awaiting review' },
];

export const JOURNEYS: Record<Journey, JourneyStep[]> = {
  TOF_NURTURE_8,
  ENROLLED_EXTENSION_5,
  INTERNAL_REVIEW,
};

/**
 * The step whose copy contains {{Competition 1..3}} and {{Why it fits}}.
 * A student with no saved picks must not receive it — see `enqueueJourney`.
 */
export const PICKS_DEPENDENT_STEPS: Partial<Record<Journey, number[]>> = {
  ENROLLED_EXTENSION_5: [4],
};

export function stepsFor(journey: Journey): JourneyStep[] {
  return JOURNEYS[journey];
}
