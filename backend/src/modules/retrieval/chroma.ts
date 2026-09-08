/**
 * ChromaDB Cloud client and region-scoped competition search.
 *
 * Chroma is a derived index over Postgres, used for candidate generation only.
 * Hard eligibility (grade, team size, closed cycles) is decided in SQL against
 * the authoritative rows — Chroma narrows, SQL decides.
 */

import { CloudClient, ChromaClient } from 'chromadb';
import { DefaultEmbeddingFunction } from '@chroma-core/default-embed';
import { config } from '../../lib/config.js';

export type Region = 'India' | 'USA';

/**
 * Students give their country at signup, so retrieval is scoped to their region
 * rather than filtered afterwards. The India and US sheets list overlapping
 * competitions with different eligibility text, so serving the wrong region's
 * document would give a student eligibility rules that don't apply to them.
 */
export function regionForCountry(country: string | null | undefined): Region | null {
  if (!country) return null;
  const c = country.trim().toLowerCase();
  if (['india', 'in', 'ind', 'bharat'].includes(c)) return 'India';
  if (['usa', 'us', 'united states', 'united states of america', 'u.s.', 'u.s.a.'].includes(c)) {
    return 'USA';
  }
  return null;
}

let client: CloudClient | ChromaClient | null = null;
let embedder: DefaultEmbeddingFunction | null = null;

/**
 * The query-side embedder.
 *
 * The collection is written by the Python ingest using Chroma's bundled ONNX
 * all-MiniLM-L6-v2. The JS client has no embedder built in, so without this the
 * query text cannot be turned into a vector at all — the failure is
 * "No embedding function found for collection", not a bad result.
 *
 * @chroma-core/default-embed runs the identical model: embedding the same string
 * on both sides gives cosine 1.000000. That equality is the whole requirement —
 * a different model here would silently return nonsense rankings rather than
 * erroring, because the vectors would still be the right shape.
 */
function getEmbedder(): DefaultEmbeddingFunction {
  embedder ??= new DefaultEmbeddingFunction();
  return embedder;
}

function getClient(): CloudClient | ChromaClient {
  if (client) return client;

  if (config.CHROMA_MODE === 'cloud') {
    const missing = (
      [
        ['CHROMA_TENANT', config.CHROMA_TENANT],
        ['CHROMA_DATABASE', config.CHROMA_DATABASE],
        ['CHROMA_API_KEY', config.CHROMA_API_KEY],
      ] as const
    )
      .filter(([, v]) => !v)
      .map(([k]) => k);

    if (missing.length > 0) {
      // Failing loudly beats silently querying an empty local store.
      throw new Error(`CHROMA_MODE=cloud requires ${missing.join(', ')}`);
    }

    client = new CloudClient({
      tenant: config.CHROMA_TENANT!,
      database: config.CHROMA_DATABASE!,
      apiKey: config.CHROMA_API_KEY!,
    });
    return client;
  }

  client = new ChromaClient({ host: config.CHROMA_HOST, port: config.CHROMA_PORT });
  return client;
}

export interface SearchHit {
  /** Region-qualified id, matching Competition.slug in Postgres. */
  slug: string;
  baseSlug: string;
  name: string;
  region: string;
  /** Cosine similarity, higher is better. */
  score: number;
  document: string;
}

export interface SearchOptions {
  query: string;
  /** Omit to search every region; normally set from the student's country. */
  region?: Region | null;
  limit?: number;
}

/**
 * Candidate generation. Deliberately over-fetches: the caller re-checks every
 * hit against Postgres and drops anything ineligible before ranking.
 */
export async function searchCompetitions(opts: SearchOptions): Promise<SearchHit[]> {
  const limit = opts.limit ?? 30;
  const collection = await getClient().getCollection({
    name: config.CHROMA_COLLECTION,
    embeddingFunction: getEmbedder(),
  });

  // Region is the only metadata filter. Domain is deliberately NOT filtered here:
  // 109 of 237 competitions have no Subject/Domain cell, so a domain filter would
  // hide most of the repository. Domain relevance comes from the semantic query
  // and from the reranker, which sees each candidate's domains.
  const where = opts.region ? { region: opts.region } : undefined;

  const result = await collection.query({
    queryTexts: [opts.query],
    nResults: limit,
    ...(where ? { where: where as never } : {}),
  });

  const ids = result.ids[0] ?? [];
  const distances = result.distances?.[0] ?? [];
  const metadatas = result.metadatas?.[0] ?? [];
  const documents = result.documents?.[0] ?? [];

  return ids.map((id, i) => {
    const meta = (metadatas[i] ?? {}) as Record<string, unknown>;
    return {
      slug: id,
      baseSlug: String(meta['base_slug'] ?? id),
      name: String(meta['name'] ?? id),
      region: String(meta['region'] ?? ''),
      score: 1 - (distances[i] ?? 1),
      document: documents[i] ?? '',
    };
  });
}

export async function collectionStats(): Promise<{ name: string; count: number }> {
  const collection = await getClient().getCollection({
    name: config.CHROMA_COLLECTION,
    embeddingFunction: getEmbedder(),
  });
  return { name: config.CHROMA_COLLECTION, count: await collection.count() };
}
