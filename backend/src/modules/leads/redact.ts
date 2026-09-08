/**
 * Repository protection for the public matcher.
 *
 * Hiding locked cards in the UI is not protection — the payload was still in the
 * response body, so anyone could read every match in devtools. The gate has to
 * be applied server-side: before a lead is captured, a TOF response carries the
 * free sample in full and nothing but a shape for the rest.
 *
 * A locked item keeps only its rank and fit bucket. No slug, no name, no
 * deadline, no reason — the reason text alone would often identify the
 * competition.
 */

export interface LockedItem {
  rank: number;
  fitBucket: string;
  locked: true;
}

interface PayloadItem {
  rank: number;
  fitBucket: string;
  pinned?: boolean;
  [key: string]: unknown;
}

export interface RedactionResult {
  payload: unknown;
  lockedCount: number;
}

/**
 * Keep the free sample visible, lock the rest.
 *
 * The visible one is the pinned entry (CREST) when there is one; otherwise the
 * top-ranked item, so a region with no pin still gets a usable free result
 * rather than an entirely locked page.
 */
export function redactForLockedLead(payload: unknown): RedactionResult {
  const source = payload as { items?: PayloadItem[] } | null;
  const items = source?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return { payload, lockedCount: 0 };
  }

  const freeIndex = Math.max(
    0,
    items.findIndex((item) => item.pinned === true),
  );

  const redacted = items.map((item, index) =>
    index === freeIndex
      ? item
      : ({ rank: item.rank, fitBucket: item.fitBucket, locked: true } satisfies LockedItem),
  );

  return {
    payload: { ...(source as object), items: redacted },
    lockedCount: redacted.length - 1,
  };
}
