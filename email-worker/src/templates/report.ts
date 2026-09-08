/**
 * The TOF competition report — the thing a lead gets in exchange for their
 * details. Not part of a drip: it is sent immediately on unlock.
 *
 * Sent as step 0 of TOF_NURTURE_8 so it shares the journey's identity while
 * sitting outside the Day 1-21 sequence.
 */

import { bookCall, p, repeat, type EmailTemplate } from './blocks.js';

export const TOF_REPORT: EmailTemplate = {
  subject: 'Your personalised competition matches',
  requires: ['Student Name', 'Competition 1'],
  blocks: [
    p('Hi {{Student/Parent Name}},'),
    p(
      'Here are the competitions we think are the strongest fit for the project you described. Each one was checked against the eligibility, format and timeline we hold for it, so these are opportunities {{Student Name}} can actually enter.',
    ),
    repeat('Competition', 'Why it fits', 8),
    p(
      'These were selected on project fit, eligibility, expected technical depth, competition standard and timelines — not on prestige alone.',
    ),
    p(
      'The next question is which of these is worth preparing for properly, and what the project would need before submitting. If you would like to talk that through with us:',
    ),
    bookCall('Book a Consultation'),
  ],
};
