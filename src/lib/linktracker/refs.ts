// Pure helpers of the Link Tracker mirror — no imports, testable without the HTTP client.
// The external ref is the dedup contract on BOTH sides (OpenGSC queue + registry notes), so
// its stability is what prevents duplicate registry rows across retries and re-imports.

export interface TrackerLink {
  id: number;
  placementUrl: string;
  targetUrl: string;
  anchorText: string;
  partnerName: string;
  linkType: string;
  particular: string;
  status: string;
  notes: string;
}

/** One externalRef per placement: the normalized donor+target pair plus the provenance
 *  prefix. Bounded so it always fits a unique index. */
export function placementRef(donorUrl: string, targetUrl: string, prefix: string): string {
  return `ogsc-${prefix}-${donorUrl}|${targetUrl}`.slice(0, 300);
}

/** Pure: pick the row whose notes carries our external reference. The registry has no filter
 *  params, so a scan it is — registry volume is placements, not logs; fine at this scale. */
export function findByRef(links: TrackerLink[], externalRef: string): TrackerLink | undefined {
  const ref = externalRef.trim();
  return links.find(l => String(l.notes ?? "").trim() === ref);
}
