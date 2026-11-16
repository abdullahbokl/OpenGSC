// Compacting scraped competitor pages down to what an outline is actually built from.
//
// Ten scraped pages handed to the model verbatim is not "more context", it is a bigger prompt that
// a reasoning model responds to by thinking longer and truncating sooner. Worse, most of what the
// scrape returns is shared boilerplate: the same cookie banner, the same menu, the same affiliate
// disclosure, ten times over. Compaction removes that and keeps what the outline needs — specs,
// prices, names, headings — inside a fixed character budget.
//
// Deterministic and network-free: a summariser here would cost one request per page and could drop
// the single concrete fact the outline is supposed to be grounded in.

/**
 * The part of a scraped source compaction cares about.
 *
 * Structural, with no index signature on purpose: `CompetitorInput` in the outline step carries six
 * more fields (position, headings, word_count…) and an index signature here would make it stop
 * satisfying this type. Everything else is preserved by the spread in `compactCompetitorPages`.
 */
export interface CompactableCompetitor {
  url: string;
  text_sample?: string;
  site_type?: string;
}

export const CONTEXT_BUDGET_CHARS = 24000;
/** Per-source cap when the budget is generous; scaled down as sources are added. */
const CONTEXT_PER_SOURCE_MAX = 3200;
const CONTEXT_PER_SOURCE_MIN = 900;

export interface CompactionStats {
  sources_in: number;
  sources_kept: number;
  dropped_duplicate: number;
  dropped_over_budget: number;
  chars_in: number;
  chars_out: number;
  /** Lines removed because three or more sources carried them verbatim. */
  boilerplate_lines: number;
}

/** Normalised 6-word shingles — cheap near-duplicate detection without an embedding model. */
function shingles(text: string): Set<string> {
  const words = text.toLowerCase().replace(/\s+/g, " ").split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 6 <= words.length; i += 2) out.add(words.slice(i, i + 6).join(" "));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Lines (sentences/rows) of one page, normalised enough to compare across sources. */
function pageLines(text: string): string[] {
  return String(text || "")
    // Sentence punctuation for both scripts: Arabic uses ۔ and ؟ where English uses . and ?
    .split(/\n+|(?<=[.!?؟۔])\s+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 12);
}

/**
 * Trim competitor pages to a budget without losing the parts an outline is built from.
 *
 * Order matters: dedupe first (a syndicated article otherwise eats two slots and its own budget),
 * then drop cross-source boilerplate, then distribute what is left. Sources are ranked the way the
 * prompt ranks them — official first — so the budget is spent on the most authoritative pages.
 *
 * Sources dropped for budget still travel as title-only rows, so the outline keeps knowing those
 * pages exist (headings, word count) without paying for their body.
 */
export function compactCompetitorPages<T extends CompactableCompetitor>(
  competitors: T[],
  budgetChars = CONTEXT_BUDGET_CHARS,
): { items: T[]; stats: CompactionStats } {
  const stats: CompactionStats = {
    sources_in: competitors.length, sources_kept: 0, dropped_duplicate: 0,
    dropped_over_budget: 0, chars_in: 0, chars_out: 0, boilerplate_lines: 0,
  };
  const withText = competitors.filter((c) => String(c.text_sample || "").trim().length > 80);
  stats.chars_in = withText.reduce((sum, c) => sum + String(c.text_sample || "").length, 0);
  if (!withText.length) return { items: competitors, stats };

  const ranked = [...withText].sort(
    (a, b) => (b.site_type === "official_store" ? 1 : 0) - (a.site_type === "official_store" ? 1 : 0),
  );

  // 1) near-duplicate removal
  const kept: { item: T; shingles: Set<string> }[] = [];
  for (const item of ranked) {
    const sh = shingles(String(item.text_sample || ""));
    if (kept.some((k) => jaccard(k.shingles, sh) >= 0.6)) { stats.dropped_duplicate += 1; continue; }
    kept.push({ item, shingles: sh });
  }

  // 2) cross-source boilerplate lines
  const counts = new Map<string, number>();
  const perPage = kept.map(({ item }) => pageLines(String(item.text_sample || "")));
  for (const lines of perPage) {
    for (const line of new Set(lines.map((l) => l.toLowerCase()))) {
      counts.set(line, (counts.get(line) || 0) + 1);
    }
  }
  const boilerplate = new Set<string>();
  for (const [line, n] of counts) if (n >= 3) boilerplate.add(line);
  stats.boilerplate_lines = boilerplate.size;

  // 3) budget distribution: every source keeps at least MIN, the rest is shared evenly.
  const count = kept.length;
  const perSource = Math.max(
    CONTEXT_PER_SOURCE_MIN,
    Math.min(CONTEXT_PER_SOURCE_MAX, Math.floor(budgetChars / Math.max(1, count))),
  );

  const items: T[] = [];
  let remaining = budgetChars;
  kept.forEach(({ item }, index) => {
    if (remaining < CONTEXT_PER_SOURCE_MIN) { stats.dropped_over_budget += 1; return; }
    const cap = Math.min(perSource, remaining);
    const body = perPage[index]
      .filter((line) => !boilerplate.has(line.toLowerCase()))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    // Below this there is nothing left worth grounding an outline in — but it must stay low: a
    // source whose body was mostly shared boilerplate keeps only its own sentence or two, and that
    // sentence is often the only concrete fact the page contributed.
    if (body.length < 40) { stats.dropped_over_budget += 1; return; }
    const trimmed = body.slice(0, cap);
    remaining -= trimmed.length;
    items.push({ ...item, text_sample: trimmed });
  });
  stats.sources_kept = items.length;
  stats.chars_out = items.reduce((sum, c) => sum + String(c.text_sample || "").length, 0);
  const keptUrls = new Set(items.map((i) => i.url));
  for (const c of competitors) {
    if (!keptUrls.has(c.url)) items.push({ ...c, text_sample: undefined });
  }
  return { items, stats };
}
