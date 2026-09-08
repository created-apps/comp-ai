/**
 * Seed Postgres from the ingest pipeline's normalized JSON.
 *
 *   npm run seed:competitions -- ../data/competitions.normalized.json
 *
 * The Python ingest writes that file and indexes Chroma from the same records,
 * so Postgres and the vector store cannot drift: one parser, two sinks.
 * Postgres is the source of truth; Chroma is a rebuildable index.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prisma } from '../../lib/prisma.js';
import type { DeadlinePrecision, Difficulty } from '@prisma/client';

interface NormalizedCompetition {
  slug: string;
  base_slug: string;
  name: string;
  region: string;
  region_code: string;
  regions: string[];
  source_sheets: string[];
  description: string | null;
  submission_details: string | null;
  domains: string[];
  domains_raw: string | null;
  deadline_date: string | null;
  deadline_month: number | null;
  deadline_year: number | null;
  deadline_text: string | null;
  deadline_precision: string;
  is_rolling: boolean;
  grade_min: number | null;
  grade_max: number | null;
  age_min: number | null;
  age_max: number | null;
  eligibility_raw: string | null;
  allows_individual: boolean | null;
  allows_team: boolean | null;
  team_min: number | null;
  team_max: number | null;
  team_raw: string | null;
  registration_status: string | null;
  registration_text: string | null;
  prestige: number | null;
  selectivity: number | null;
  complexity: number | null;
  time_investment: number | null;
  total_score: number | null;
  difficulty: string | null;
  official_urls: string[];
  winner_lists: string | null;
  notes: string | null;
  comments: string | null;
  source_rows: unknown[];
  warnings: string[];
  document: string;
  content_hash: string;
}

const PRECISION: Record<string, DeadlinePrecision> = {
  day: 'DAY',
  month: 'MONTH',
  year: 'YEAR',
  rolling: 'ROLLING',
  unknown: 'UNKNOWN',
};

function toDifficulty(value: string | null): Difficulty | null {
  if (value === 'EASY' || value === 'MEDIUM' || value === 'HARD') return value;
  return null;
}

async function main(): Promise<void> {
  const arg = process.argv[2] ?? '../data/competitions.normalized.json';
  const path = resolve(process.cwd(), arg);

  const raw = await readFile(path, 'utf8').catch(() => {
    throw new Error(
      `Could not read ${path}.\nRun the ingest first:\n` +
        `  cd ingest && python ingest_competitions.py --india ... --us ... --dry-run`,
    );
  });

  const parsed = JSON.parse(raw) as { competitions: NormalizedCompetition[] };
  const comps = parsed.competitions ?? [];
  if (comps.length === 0) throw new Error(`${path} contains no competitions`);

  console.log(`Seeding ${comps.length} competitions from ${path}`);

  let created = 0;
  let updated = 0;

  for (const c of comps) {
    const data = {
      name: c.name,
      baseSlug: c.base_slug,
      region: c.region,
      regionCode: c.region_code,
      regions: c.regions,
      sourceSheets: c.source_sheets,
      description: c.description,
      submissionDetails: c.submission_details,
      domains: c.domains,
      domainsRaw: c.domains_raw,
      deadlineDate: c.deadline_date ? new Date(`${c.deadline_date}T00:00:00Z`) : null,
      deadlineMonth: c.deadline_month,
      deadlineYear: c.deadline_year,
      deadlineText: c.deadline_text,
      deadlinePrecision: PRECISION[c.deadline_precision] ?? 'UNKNOWN',
      isRolling: c.is_rolling,
      gradeMin: c.grade_min,
      gradeMax: c.grade_max,
      ageMin: c.age_min,
      ageMax: c.age_max,
      eligibilityRaw: c.eligibility_raw,
      allowsIndividual: c.allows_individual,
      allowsTeam: c.allows_team,
      teamMin: c.team_min,
      teamMax: c.team_max,
      teamRaw: c.team_raw,
      registrationStatus: c.registration_status,
      registrationText: c.registration_text,
      prestige: c.prestige,
      selectivity: c.selectivity,
      complexity: c.complexity,
      timeInvestment: c.time_investment,
      totalScore: c.total_score,
      difficulty: toDifficulty(c.difficulty),
      officialUrls: c.official_urls,
      winnerLists: c.winner_lists,
      notes: c.notes,
      comments: c.comments,
      contentHash: c.content_hash,
      sourceRows: c.source_rows as object,
      warnings: c.warnings,
    };

    const existing = await prisma.competition.findUnique({
      where: { slug: c.slug },
      select: { id: true },
    });

    await prisma.competition.upsert({
      where: { slug: c.slug },
      create: { slug: c.slug, ...data },
      // Deliberately does NOT touch lastVerifiedAt / verifiedById / cycleActive:
      // a re-seed must not silently un-verify a competition a human approved.
      update: data,
    });

    existing ? updated++ : created++;
  }

  console.log(`  created ${created}, updated ${updated}`);

  const byRegion = await prisma.competition.groupBy({ by: ['region'], _count: true });
  for (const row of byRegion) console.log(`  ${row.region}: ${row._count}`);

  const unverified = await prisma.competition.count({ where: { lastVerifiedAt: null } });
  const noUrl = await prisma.competition.count({ where: { officialUrls: { isEmpty: true } } });
  console.log(`  ${unverified} never web-verified, ${noUrl} without a stored official URL`);
  console.log('  (a missing URL is fine — verification searches the web from the');
  console.log('   competition details and discovers the official source itself)');
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
