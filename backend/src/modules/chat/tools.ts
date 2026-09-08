/**
 * Competition AI — the tool surface.
 *
 * The chatbot is a tool-using agent, not a prompt stuffed with the repository.
 * Every tool returns data through the same DTO serializers the REST API uses, so
 * the model can never surface a field the API would not return. That is the
 * security boundary; the prompt is a second line of defence, never the first.
 *
 * Enrolled students only. The TOF variant would need the public DTO, tighter
 * caps and an enumeration guard, so rather than half-build it the route refuses
 * anyone else outright.
 */

import { z } from 'zod';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { PrismaClient } from '@prisma/client';
import { regionForCountry, searchCompetitions } from '../retrieval/chroma.js';
import { toInternalDto, toMilestoneDto } from '../competitions/dto.js';
import { checkEligibility } from '../recommend/eligibility.js';

/** Enough to answer a question without letting one turn dump the repository. */
const SEARCH_LIMIT = 5;

export interface ChatContext {
  prisma: PrismaClient;
  studentId: string;
  /** Region-scopes every search, exactly as the recommendation pipeline does. */
  country: string | null;
  grade: number | null;
  age: number | null;
  /** Slugs surfaced so far in this session, for the exposure cap. */
  seen: Set<string>;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function buildTools(ctx: ChatContext) {
  const region = regionForCountry(ctx.country);

  const searchTool = betaZodTool({
    name: 'search_competitions',
    description:
      'Search the CreatED competition repository by topic, subject or keyword. Returns competitions relevant to the query, scoped to the student\'s region. Use this whenever the student asks what they could enter, or about a kind of competition rather than a named one.',
    inputSchema: z.object({
      query: z
        .string()
        .describe('What to search for, in the vocabulary a competition listing would use.'),
    }),
    run: async ({ query }) => {
      const hits = await searchCompetitions({ query, region, limit: SEARCH_LIMIT });
      if (hits.length === 0) return json({ results: [], note: 'nothing in the repository matched' });

      const competitions = await ctx.prisma.competition.findMany({
        where: { slug: { in: hits.map((h) => h.slug) } },
        include: { milestones: { orderBy: { order: 'asc' } } },
      });

      const results = competitions.map((c) => {
        ctx.seen.add(c.slug);
        const eligibility = checkEligibility(c, {
          grade: ctx.grade,
          age: ctx.age,
          ...(region ? { region } : {}),
        });
        return {
          ...toInternalDto(c, c.milestones),
          eligibleForThisStudent: eligibility.eligible,
          // Surfaced so the model can say "the sheet does not state a grade
          // range" instead of implying eligibility was checked and passed.
          notVerified: eligibility.unverified,
          ...(eligibility.eligible
            ? {}
            : { whyNotEligible: eligibility.rejections.map((r) => r.detail) }),
        };
      });

      return json({ results });
    },
  });

  const getTool = betaZodTool({
    name: 'get_competition',
    description:
      'Fetch one competition by its exact name. Use when the student names a competition and you need its dates, eligibility or submission requirements.',
    inputSchema: z.object({
      name: z.string().describe('The competition name as the student wrote it.'),
    }),
    run: async ({ name }) => {
      const competition = await ctx.prisma.competition.findFirst({
        where: {
          name: { contains: name, mode: 'insensitive' },
          ...(region ? { region } : {}),
        },
        include: { milestones: { orderBy: { order: 'asc' } } },
      });

      if (!competition) {
        return json({
          found: false,
          note: `No competition matching "${name}" is in the repository for this student's region. Say so rather than answering from general knowledge.`,
        });
      }

      ctx.seen.add(competition.slug);
      const eligibility = checkEligibility(competition, {
        grade: ctx.grade,
        age: ctx.age,
        ...(region ? { region } : {}),
      });

      return json({
        found: true,
        ...toInternalDto(competition, competition.milestones),
        eligibleForThisStudent: eligibility.eligible,
        notVerified: eligibility.unverified,
        ...(eligibility.eligible
          ? {}
          : { whyNotEligible: eligibility.rejections.map((r) => r.detail) }),
      });
    },
  });

  const myRecommendationsTool = betaZodTool({
    name: 'get_my_recommendations',
    description:
      "The student's own latest approved recommendation set, with the reason each competition was chosen. Use when they ask about 'my competitions' or why something was recommended.",
    inputSchema: z.object({}),
    run: async () => {
      const run = await ctx.prisma.recommendationRun.findFirst({
        where: { project: { studentId: ctx.studentId }, status: 'APPROVED' },
        orderBy: { createdAt: 'desc' },
        select: { payload: true, createdAt: true },
      });

      if (!run) {
        return json({
          recommendations: [],
          note: 'No approved recommendations yet — a mentor reviews them before the student sees them.',
        });
      }

      const items =
        (run.payload as unknown as { items?: { competition?: { slug?: string } }[] })?.items ?? [];
      for (const item of items) if (item.competition?.slug) ctx.seen.add(item.competition.slug);

      return json({ generatedAt: run.createdAt, ...(run.payload as object) });
    },
  });

  const myMilestonesTool = betaZodTool({
    name: 'get_my_deadlines',
    description:
      "Upcoming milestones for the competitions in the student's saved picks, with how recently each was verified against the official source.",
    inputSchema: z.object({}),
    run: async () => {
      const picks = await ctx.prisma.enrolledTopPicks.findUnique({
        where: { studentId: ctx.studentId },
      });
      const names = [picks?.competition1, picks?.competition2, picks?.competition3].filter(
        (n): n is string => Boolean(n),
      );
      if (names.length === 0) {
        return json({ deadlines: [], note: 'No saved competitions for this student yet.' });
      }

      const competitions = await ctx.prisma.competition.findMany({
        where: { name: { in: names }, ...(region ? { region } : {}) },
        include: { milestones: { orderBy: { order: 'asc' } } },
      });

      return json({
        deadlines: competitions.map((c) => ({
          competition: c.name,
          deadline: c.deadlineText,
          deadlinePrecision: c.deadlinePrecision,
          isRolling: c.isRolling,
          // The model must not present an unverified date as fact.
          lastVerifiedAt: c.lastVerifiedAt,
          milestones: c.milestones.map(toMilestoneDto),
        })),
      });
    },
  });

  return [searchTool, getTool, myRecommendationsTool, myMilestonesTool];
}

export const CHAT_SYSTEM = `You are Competition AI, CreatED's assistant for enrolled students. You help a student understand competitions: what they could enter, what a competition expects, and when things are due.

How you work:
- Everything you say about a competition must come from a tool result in this conversation. You have no competition knowledge of your own — the repository is the only source.
- If a tool returns nothing, say plainly that the competition is not in CreatED's repository and offer to search differently. Never fill the gap from general knowledge, however confident you feel: a competition you half-remember may not exist, may have been renamed, or may not accept this student.
- Name the competitions you are drawing on, so the student can check them.

About dates and eligibility:
- Much of the repository is incomplete. When a tool reports a field as not recorded or not verified, say so — "the sheet doesn't state a grade range" is useful; implying it was checked is not.
- If lastVerifiedAt is null or old, tell the student to confirm on the official site before relying on the date. A wrong date reaches them as a missed deadline.
- If a tool says the student is not eligible, lead with that. Do not encourage an application they cannot make.

Tone: direct and practical, like a mentor who knows the student's work. Short answers. No filler, no motivational padding.`;
