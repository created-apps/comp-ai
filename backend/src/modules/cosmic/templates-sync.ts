/**
 * Pushes the competition repository into COSMIC as competition templates.
 *
 * A competition can only be assigned to a kid in COSMIC if a template for it
 * exists there, and COSMIC's templates were hand-seeded one at a time (IRIS).
 * Rather than creating a template lazily at the moment a student selects — which
 * would make the slowest, most visible request also the one doing setup work —
 * every active competition is synced up front and re-synced after an ingest.
 *
 * The upsert is keyed on the comp-ai slug, so a competition that already exists
 * in COSMIC as a hand-configured template is linked to rather than duplicated,
 * and its requirement tree is never touched.
 *
 *   npm run cosmic:sync-templates
 */

import { prisma } from '../../lib/prisma.js';
import { cosmicClient, cosmicConfigured, type CosmicClient } from './client.js';

export interface TemplateSyncSummary {
  seen: number;
  created: number;
  updated: number;
  failed: number;
  errors: string[];
}

export async function syncTemplates(
  client: CosmicClient = cosmicClient,
): Promise<TemplateSyncSummary> {
  const competitions = await prisma.competition.findMany({
    where: { cycleActive: true },
    select: {
      slug: true,
      name: true,
      region: true,
      description: true,
      submissionDetails: true,
      deadlineDate: true,
      deadlinePrecision: true,
      deadlineText: true,
    },
    orderBy: { slug: 'asc' },
  });

  const summary: TemplateSyncSummary = {
    seen: competitions.length,
    created: 0,
    updated: 0,
    failed: 0,
    errors: [],
  };

  for (const c of competitions) {
    try {
      const result = await client.upsertTemplate({
        compAiSlug: c.slug,
        // The region belongs in the name: COSMIC lists templates flat, and the
        // India and US listings of one competition are different deadlines.
        name: `${c.name} (${c.region})`,
        description: c.description ?? c.submissionDetails ?? null,
        // Only a real day-precision deadline is sent. A month-precision or
        // rolling deadline would become a confident internal date COSMIC
        // schedules reminders against — the exact guess the pipeline refuses to
        // make everywhere else.
        finalDeadline:
          c.deadlinePrecision === 'DAY' && c.deadlineDate
            ? c.deadlineDate.toISOString().slice(0, 10)
            : null,
        complianceWarning: null,
      });
      result.created ? summary.created++ : summary.updated++;
    } catch (err) {
      summary.failed++;
      summary.errors.push(`${c.slug}: ${err instanceof Error ? err.message : 'failed'}`);
    }
  }

  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!cosmicConfigured()) {
    console.error(
      'COSMIC is not configured. Set COSMIC_API_URL, COSMIC_SERVICE_EMAIL and COSMIC_SERVICE_PASSWORD in backend/.env.',
    );
    process.exit(1);
  }

  const summary = await syncTemplates();
  console.log(
    `templates: ${summary.seen} seen, ${summary.created} created, ${summary.updated} updated, ${summary.failed} failed`,
  );
  for (const error of summary.errors.slice(0, 20)) console.error('  ' + error);
  await prisma.$disconnect();
  process.exit(summary.failed > 0 ? 1 : 0);
}
