// Pure helpers for the free Competitors path (no Semrush / Keys.so key).
//
// The paid path buys organic-keyword lists from a provider. The free path rebuilds the same
// operator answer from what the app already has: the target site's own GSC queries seed live
// SERP pulls (SearXNG, or Serper when a key exists), and competitor keyword rows are what the
// SERPs actually show. Every number downstream is therefore an observed position or an observed
// presence — volume and difficulty simply do not exist here, and these helpers never invent one.
//
// Kept free of I/O and of the serp/scrape modules so unit tests run without network shims.

export interface FreeSerpRow {
  position: number;
  url: string;
  title: string;
  domain: string;
}

export interface FreeFound {
  domain: string;
  /** How many of the seed queries this domain showed up on — an observed count, not a metric. */
  sharedKeywords: number;
}

export interface FreeKeywordRow {
  keyword: string;
  position: number;
  url: string;
}

/** (query, rows) pair — the shape the route holds after each seed SERP call. */
export interface SeededSerp {
  query: string;
  rows: FreeSerpRow[];
}

/** "www.example.com" and "example.com" are one competitor; "blog.example.com" is too. */
export function domainMatches(candidate: string, domain: string): boolean {
  const c = candidate.trim().toLowerCase().replace(/^www\./, "");
  const d = domain.trim().toLowerCase().replace(/^www\./, "");
  return !!c && !!d && (c === d || c.endsWith(`.${d}`));
}

/**
 * Seed queries for the SERP pulls: the target site's own GSC queries by impressions.
 *
 * Brand-ish queries are dropped — searching your own brand surfaces your own domain and a row of
 * directories, which aggregates into false competitors. With no GSC history yet the caller falls
 * back to a domain-derived seed, so a fresh site still gets one pull instead of a dead end.
 */
export function seedQueriesFromGsc(
  rows: { query: string; impressions: number }[],
  ownDomain: string,
  max = 8,
): string[] {
  const host = ownDomain.trim().toLowerCase().replace(/^www\./, "");
  const root = host.split(".")[0];
  const seen = new Set<string>();
  const out: { query: string; impressions: number }[] = [];
  for (const r of rows) {
    const q = String(r.query ?? "").trim().toLowerCase();
    if (!q || q.length > 120) continue;
    // Navigational queries only: the bare brand ("ketotifen") and anything containing the
    // domain itself ("ketotifen.com reviews") surface directories, not competitors. A topical
    // query that happens to mention the brand ("ketotifen dose") stays — it is real demand.
    if (q === root || (host && q.includes(host))) continue;
    const key = q.replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ query: key, impressions: Number(r.impressions ?? 0) });
  }
  out.sort((a, b) => b.impressions - a.impressions);
  return out.slice(0, max).map(r => r.query);
}

/**
 * Competitor candidates from one SERP result list per seed query.
 *
 * Coverage (how many seeds a domain appeared on) is the ranking signal: a domain on eight of the
 * site's own top queries is a real competitor, a domain on one is probably a directory or a news
 * hit. Everything observed is kept — the user, not a hardcoded aggregator blocklist, decides what
 * matters; the exclusion of the target's own domain is the only filter.
 */
export function aggregateCompetitorsFromSerp(
  seeded: SeededSerp[],
  ownDomain: string,
  max = 20,
): FreeFound[] {
  const count = new Map<string, number>();
  for (const { rows } of seeded) {
    const domains = new Set<string>();
    for (const r of rows) {
      if (!r.domain || domainMatches(r.domain, ownDomain)) continue;
      domains.add(r.domain.toLowerCase().replace(/^www\./, ""));
    }
    for (const d of domains) count.set(d, (count.get(d) ?? 0) + 1);
  }
  return [...count.entries()]
    .map(([domain, sharedKeywords]) => ({ domain, sharedKeywords }))
    .sort((a, b) => b.sharedKeywords - a.sharedKeywords || a.domain.localeCompare(b.domain))
    .slice(0, max);
}

/**
 * One competitor's keyword rows from the seed SERPs: only rows the competitor actually holds.
 *
 * A query can return the same competitor twice (two URLs); the better position wins, and the URL
 * travels with it — that is what the gap table links to. Nothing is stored for a query where the
 * competitor does not appear: absence is honest, a fabricated row is not.
 */
export function competitorRowsFromQueries(
  seeded: SeededSerp[],
  competitor: string,
  maxPosition: number,
): FreeKeywordRow[] {
  const best = new Map<string, FreeKeywordRow>();
  for (const { query, rows } of seeded) {
    for (const r of rows) {
      if (!r.domain || r.position > maxPosition) continue;
      if (!domainMatches(r.domain, competitor)) continue;
      const prev = best.get(query);
      if (!prev || r.position < prev.position) {
        best.set(query, { keyword: query, position: r.position, url: r.url });
      }
    }
  }
  return [...best.values()].sort((a, b) => a.position - b.position);
}

/**
 * Keyword candidates scraped out of a competitor page's own headings.
 *
 * Titles and H1/H2s are what the competitor chose to rank — a far better keyword guess than page
 * body n-grams. Cleaned hard: navigation labels, ultra-short fragments and over-long sentences
 * are noise that would only burn SERP calls downstream.
 */
export function extractKeywordCandidates(
  page: { title?: string; headings?: string[] },
  max = 6,
): string[] {
  const raw: string[] = [];
  if (page.title) raw.push(page.title);
  for (const h of page.headings ?? []) {
    const m = /^H[12]:\s*(.+)$/.exec(h);
    if (m) raw.push(m[1]);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (let s of raw) {
    s = s.replace(/\s+/g, " ").trim();
    // Split on separators pages use to bolt the brand on: "Best Running Shoes — ACME".
    s = s.split(/\s*[|·—–]\s*|\s+-\s+/)[0]?.trim() ?? "";
    const words = s.split(" ").filter(Boolean);
    if (words.length < 2 || words.length > 9 || s.length < 6 || s.length > 90) continue;
    if (/^(home|about|contact|blog|shop|menu|search|news|welcome|faq|privacy|terms)$/i.test(s)) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}
