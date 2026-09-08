/**
 * Detect migrations that exist on disk but were never applied to the database.
 *
 * `prisma generate` updates the client's types; it does not touch the database.
 * So a schema change plus a generate leaves code that compiles cleanly and then
 * fails at runtime with "The column X does not exist in the current database" —
 * on whichever route happens to touch the new column first.
 *
 * This compares the migrations folder against Prisma's own `_prisma_migrations`
 * table, so it needs no list of expected columns and cannot go stale.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';

export interface SchemaState {
  pending: string[];
  /** Set when the check itself could not run — never treated as "all good". */
  error?: string;
}

export async function pendingMigrations(prisma: PrismaClient): Promise<SchemaState> {
  const dir = fileURLToPath(new URL('../../prisma/migrations', import.meta.url));

  let onDisk: string[];
  try {
    onDisk = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'migration.sql')))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    return { pending: [], error: `could not read ${dir}: ${String(err)}` };
  }

  try {
    const rows = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
    `;
    const applied = new Set(rows.map((r) => r.migration_name));
    return { pending: onDisk.filter((name) => !applied.has(name)) };
  } catch (err) {
    return { pending: [], error: err instanceof Error ? err.message : 'query failed' };
  }
}
