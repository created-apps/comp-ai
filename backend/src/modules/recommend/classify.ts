/**
 * Stage 1 — classify the project.
 *
 * Turns a free-text project description into structured signals the retrieval
 * and ranking stages can use. Cheap, bounded, and low effort: this is extraction,
 * not judgement. The one thing it must not do is invent competitions, so it never
 * sees the repository at all.
 */

import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { assertNotRefused, getClaude, MODEL } from '../../lib/claude.js';
import { clampList } from '../../lib/clamp.js';

/** Canonical domain slugs, matching the ingest's DOMAIN_ALIASES targets. */
export const DOMAIN_SLUGS = [
  'ai',
  'computer-science',
  'robotics',
  'engineering',
  'biology',
  'medicine',
  'chemistry',
  'physics',
  'mathematics',
  'sustainability',
  'entrepreneurship',
  'economics',
  'social-impact',
  'social-sciences',
  'psychology',
  'humanities',
  'design',
  'research',
  'stem',
  'science',
  'technology',
  'open',
] as const;

const classificationSchema = z.object({
  // Counts are guidance in the description, not schema constraints: returning
  // five domains instead of four must not fail the whole classification.
  domains: z
    .array(z.enum(DOMAIN_SLUGS))
    .describe('Up to 4 canonical domains this project belongs to, most relevant first.'),
  projectType: z
    .enum(['research', 'build', 'entrepreneurship', 'design', 'writing', 'mixed'])
    .describe('The dominant kind of work.'),
  maturity: z
    .enum(['IDEA', 'RESEARCHED', 'PROTOTYPE', 'TESTED', 'PAPER'])
    .describe('How far the project has actually progressed, judged conservatively.'),
  keywords: z
    .array(z.string())
    .describe(
      '3-10 concrete topical terms for semantic search — no generic words like "project".',
    ),
  searchQuery: z
    .string()
    .describe(
      'A single retrieval query describing the project in the vocabulary a competition listing would use.',
    ),
  summary: z.string().describe('One sentence, plain language, for the internal reviewer.'),
});

export type Classification = z.infer<typeof classificationSchema>;

const SYSTEM = `You classify student project descriptions for a competition matching service.

Rules:
- Judge maturity from evidence in the text, not ambition. "I want to build" is IDEA; a described working prototype is PROTOTYPE; only claim PAPER if a written study or publication is mentioned.
- Pick domains that a competition organiser would use to categorise the work, not every field it touches.
- keywords must be specific enough to distinguish this project from others in the same field.
- searchQuery should read like the competition's own description of the work it wants, not like a student describing themselves.`;

export async function classifyProject(input: {
  domain?: string | null;
  description: string;
}): Promise<Classification> {
  const client = getClaude();

  const message = await client.messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    // Extraction, not judgement — low effort is the right cost/quality point here.
    output_config: {
      effort: 'low',
      format: zodOutputFormat(classificationSchema),
    },
    messages: [
      {
        role: 'user',
        content: [
          input.domain ? `Stated domain: ${input.domain}` : null,
          `Project description: ${input.description}`,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  });

  assertNotRefused(message);

  const parsed = message.parsed_output;
  if (!parsed) throw new Error('classification returned no structured output');

  return {
    ...parsed,
    domains: parsed.domains.slice(0, 4),
    keywords: clampList(parsed.keywords, 10),
  };
}
