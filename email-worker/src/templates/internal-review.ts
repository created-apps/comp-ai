/**
 * Internal notification: an enrolled student's recommendations need approving.
 *
 * Not marketing — this goes to the CreatED team, so it leads with what a
 * reviewer needs to decide: whose project, what was picked, and a link straight
 * into the admin console.
 */

import { cta, h, p, repeat, ul, type EmailTemplate } from './blocks.js';

export const INTERNAL_REVIEW_TEMPLATE: EmailTemplate = {
  subject: '{{Student Name}} — {{Competition Count}} competitions awaiting review',
  requires: ['Student Name', 'Project Name', 'Review URL'],
  blocks: [
    p(
      'Competition AI has generated recommendations for {{Student Name}}. They are held for review and the student cannot see them until someone approves them.',
    ),
    h('{{Project Name}}'),
    p('{{Project Description}}'),
    p('{{Student Context}}'),
    h('Recommended'),
    repeat('Competition', 'Why it fits', 8),
    cta('View competition details', '{{Review URL}}'),
    p('From there you can approve the set, or reject it and have it regenerated.'),
    ul([
      'Check each competition is one this student can actually enter.',
      'Check any deadline shown as unverified before it reaches the family.',
    ]),
  ],
};
