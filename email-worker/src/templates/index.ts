import type { Journey } from '../contract.js';
import type { EmailTemplate } from './blocks.js';
import { FLOW1 } from './flow1.js';
import { FLOW2 } from './flow2.js';
import { INTERNAL_REVIEW_TEMPLATE } from './internal-review.js';
import { TOF_REPORT } from './report.js';

const REGISTRY: Record<Journey, Record<number, EmailTemplate>> = {
  // Step 0 is the immediate report sent at the lead gate; steps 1-8 are the drip.
  TOF_NURTURE_8: { 0: TOF_REPORT, ...FLOW1 },
  ENROLLED_EXTENSION_5: FLOW2,
  INTERNAL_REVIEW: { 1: INTERNAL_REVIEW_TEMPLATE },
};

export function getTemplate(journey: Journey, step: number): EmailTemplate | null {
  return REGISTRY[journey]?.[step] ?? null;
}

export { FLOW1, FLOW2, TOF_REPORT, INTERNAL_REVIEW_TEMPLATE };
export type { EmailTemplate };
