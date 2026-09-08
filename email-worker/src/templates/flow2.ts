/**
 * Flow 2 — existing CreatED families. Five emails.
 *
 * Copy from "Competition AI email flows". Steps are in send order by their
 * stated timing (Day 1, 3, 6, 9, 13), which is not the order the source document
 * lists them in — the backend's journeys.ts records the mapping.
 *
 * The tone brief from the document: you have already built with us → this work
 * may have further potential → we know where projects like this can go → here
 * are your personalised pathways → speak to us if you want to pursue them.
 */

import { bookCall, h, hr, p, ul, type EmailTemplate } from './blocks.js';

/** Step 1 · Day 1 · document Email 1 */
const extensionPathways: EmailTemplate = {
  subject: 'Where could {{Student Name}} go next?',
  requires: ['Student Name', 'Project Name'],
  blocks: [
    p('Hi {{Student/Parent Name}},'),
    p('It has been great to see {{Student Name}} develop {{Project Name}}.'),
    p(
      'One of the advantages of completing substantial project work is that the project does not necessarily have to stop at the end of the current program.',
    ),
    p(
      'There may be opportunities to take it further through national or international competitions, additional research, or another project direction.',
    ),
    p(
      'We have put together a personalised Project Extension Pathways document for {{Student Name}} outlining what we believe could be the strongest next step, along with some specific competition opportunities that may be relevant to the current project.',
    ),
    p(
      'If you would like to talk through the recommendations and decide what is worth pursuing, we would be happy to discuss them with you.',
    ),
    bookCall('Contact Us to Book a Meeting'),
  ],
};

/** Step 2 · Day 3 · document Email 4 */
const whatActuallyWins: EmailTemplate = {
  subject: 'What separates a good project from a winning one?',
  requires: ['Project Name'],
  blocks: [
    p('Hi {{Student/Parent Name}},'),
    p(
      'One thing we see repeatedly across competitions is that good projects do not always become strong competition submissions automatically.',
    ),
    p('Judges are often looking for evidence beyond the initial concept:'),
    ul([
      'How original is the approach?',
      'Has the project been tested?',
      'What evidence supports the claims?',
      'What changed after experimentation or feedback?',
      'How clearly can the student defend the technical or research decisions?',
      'Why should this project matter relative to other submissions?',
    ]),
    p('This is where competition preparation becomes invaluable.'),
    p(
      'The process of preparing for a strong competition often forces a student to test more rigorously, document more carefully and explain the work at a deeper level.',
    ),
    p(
      'That is part of what we would assess when deciding how far to take {{Project Name}}. To discuss possible pathways for this project, let us get in touch.',
    ),
    bookCall('Contact Us to Book a Meeting'),
  ],
};

/** Step 3 · Day 6 · document Email 3 */
const whereProjectsHaveGone: EmailTemplate = {
  subject: 'What can happen after the project is built?',
  requires: ['Project Name'],
  blocks: [
    p('Hi {{Student/Parent Name}},'),
    p(
      'Some of the most interesting outcomes we have seen have happened after the initial project was already built.',
    ),
    p(
      'CreatED students have taken their projects into competitions and won prestigious awards such as:',
    ),
    h('IRIS'),
    ul([
      'Shlok Shirodkar — Built OTGP, an embedded system that uses keystroke patterns to identify users with 99% accuracy, eliminating passwords and biometric authentication.',
      'Anav Gupta — Developed an AI-powered bioinformatics algorithm to diagnose and classify Irritable Bowel Syndrome using genetic, microbiome, symptom and clinical data.',
    ]),
    h('S.T. Yau'),
    ul([
      'Dhrishit Kandhar — Investigated how evolutionary differences in lung surfactant proteins may influence susceptibility to lung fibrosis and reveal potential therapeutic targets.',
      'Jiana Shroff — Conducted research on optimising sailboat design and performance, earning an S.T. Yau Top 10 finish and an invitation to Hong Kong as the only Indian female finalist.',
    ]),
    h('Conrad Innovator Award'),
    ul([
      'Anahita Nair — Developed selective sound-suppression earbuds designed to reduce migraine-triggering sounds without blocking surrounding audio.',
      "Ayaan Shah and Hriday Parekh — Built a wearable glove using motion and flex sensors to monitor and mitigate Parkinson's tremors in real time.",
    ]),
    h('CREST Gold Award winners'),
    ul([
      'Siya Rajgarhia — Developed a rehabilitation game using guided movement, IMUs and coordination tasks to support motor recovery for people with Parkinson’s disease.',
      'Tvissha Pilani — Investigated how triboelectric nanogenerator design parameters affect energy generation from human movement for self-powered health-monitoring devices.',
    ]),
    hr(),
    p(
      'The important part is not blindly applying. It is identifying where a particular project is genuinely competitive and then preparing it at the standard expected by that competition.',
    ),
    p('For some projects, that may mean stronger testing.'),
    p('For others, better data.'),
    p('For others, a stronger pitch, submission narrative or technical explanation.'),
    p('That is how we would approach {{Project Name}} as well.'),
    bookCall('Contact Us to Book a Meeting'),
  ],
};

/**
 * Step 4 · Day 9 · document Email 2.
 *
 * The one that merges the student's three saved competitions. `requires` makes
 * the missing-variable check fail loudly: an email that ships with an empty
 * {{Competition 2}} is worse than one that never sends.
 */
const competitionTargets: EmailTemplate = {
  subject: 'Opportunities we think are worth considering for {{Project Name}}',
  requires: [
    'Student Name',
    'Project Name',
    'Competition 1',
    'Why it fits 1',
    'Competition 2',
    'Why it fits 2',
    'Competition 3',
    'Why it fits 3',
  ],
  blocks: [
    p('Hi {{Student/Parent Name}},'),
    p(
      'We wanted to highlight the competition recommendations in {{Student Name}}’s Project Extension Pathways.',
    ),
    p('Based on the nature of {{Project Name}}, we believe opportunities such as:'),
    h('{{Competition 1}}'),
    p('{{Why it fits 1}}'),
    h('{{Competition 2}}'),
    p('{{Why it fits 2}}'),
    h('{{Competition 3}}'),
    p('{{Why it fits 3}}'),
    p('may be worth considering.'),
    p('These have been selected based on factors including:'),
    ul([
      'Project fit',
      'Eligibility',
      'Expected technical depth',
      'Competition standard',
      'Timelines',
    ]),
    p(
      'The next question is whether {{Student Name}} would like to take the project into one or more of these competitions — and what would need to be strengthened before doing so.',
    ),
    p('If you would like to review the options with us:'),
    bookCall('Contact Us to Book a Meeting'),
  ],
};

/** Step 5 · Day 13 · document Email 5 */
const finalCta: EmailTemplate = {
  subject: 'Should we take {{Project Name}} further?',
  requires: ['Student Name', 'Project Name'],
  blocks: [
    p('Hi {{Student/Parent Name}},'),
    p(
      '{{Student Name}} has already done the most important part: they have put in the work and built their project.',
    ),
    p(
      'The question now is whether there is value in taking {{Project Name}} into the right competitions. To apply with a strong position, that can mean:',
    ),
    ul([
      'External feedback from judges and experts',
      'National or international exposure',
      'The possibility of meaningful recognition',
      'A stronger final body of work than the original prototype alone',
    ]),
    p(
      'Through Competition Mastery, we can help identify the strongest-fit opportunities and support the project through the application, evidence, pitch and submission process. That matches the pathways described in the one-pager you will already have received.',
    ),
    bookCall('Contact Us to Book a Meeting'),
  ],
};

/** Keyed by the backend's send-order step number. */
export const FLOW2: Record<number, EmailTemplate> = {
  1: extensionPathways,
  2: whatActuallyWins,
  3: whereProjectsHaveGone,
  4: competitionTargets,
  5: finalCta,
};
