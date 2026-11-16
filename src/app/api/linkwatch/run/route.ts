import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { rawQuery, rawExec } from "@/lib/db/raw";
import { searxngSearch, searxngConfigured } from "@/lib/seo/searxng";

// POST /api/linkwatch/run { limit?, months? }
// For every watched brand, find fresh pages on the open web that mention the brand via the
// self-hosted SearXNG instance (free, keyless — SEARXNG_BASE_URL) and store them. Link Monitor
// used to page the paid Ahrefs all-backlinks endpoint for this; Ahrefs was removed from the
// product, so the run now answers the same operator question — "who is talking about my
// competitors lately?" — from SERP mentions instead of a link index.
//
// Honesty rules: a row is a *mention*, not a verified link. urlTo/anchor stay empty (nothing
// was verified on the page), drFrom stays 0 (SearXNG carries no authority metric) and the UI
// hides those fields rather than showing zeros as data. One row per domain; the brand's own
// domain is excluded both in the query (-site:) and in the filter below, because engines may
// ignore the negation.

const rid = () => "lm" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const domainOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

const MAX_BRANDS = 200;
const MAX_RESULTS_PER_BRAND = 30;

interface MentionCandidate { url: string; title: string; domain: string }

async function fetchBrandMentions(brand: string, limit: number): Promise<{ rows?: MentionCandidate[]; error?: string }> {
  // Quoted brand phrase, own domain excluded at the engine level too. Rows are deduped against
  // stored ones by the DELETE+INSERT cycle below, which is what actually defines "fresh".
  const query = `"${brand}" -site:${brand}`;
  try {
    const res = await searxngSearch("", query, { num: limit });
    if (res.error) return { error: `searxng: ${res.error}` };
    const seen = new Set<string>();
    const rows: MentionCandidate[] = [];
    for (const r of res.results || []) {
      const url = String(r.url ?? "");
      const domain = String(r.domain || domainOf(url));
      if (!url || !domain) continue;
      if (domain === brand || domain.endsWith(`.${brand}`)) continue; // engines may ignore -site:
      if (seen.has(domain)) continue; // one per domain, like the old aggregation=1_per_domain
      seen.add(domain);
      rows.push({ url, title: String(r.title ?? ""), domain });
      if (rows.length >= limit) break;
    }
    return { rows };
  } catch (e) {
    return { error: String((e as Error)?.message ?? e) };
  }
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("spend");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  // months/limit are accepted for client compatibility; SearXNG has no DR filter, so minDr is
  // meaningless here and is deliberately not read.
  const limit = Math.max(5, Math.min(MAX_RESULTS_PER_BRAND, Number(b.limit ?? 15)));

  if (!searxngConfigured()) return NextResponse.json({ error: "searxng_not_configured" }, { status: 503 });

  let brands: { domain: string }[] = [];
  try { brands = await rawQuery(`SELECT domain FROM "LinkWatchBrand" WHERE userId = ?`, userId); }
  catch { return NextResponse.json({ error: "not_migrated" }, { status: 500 }); }
  if (!brands.length) return NextResponse.json({ error: "no_brands" }, { status: 400 });

  const errors: Record<string, string> = {};
  let saved = 0;
  // Sequential: the SearXNG adapter already serializes through one instance-wide slot; this
  // keeps a run of 200 brands from stacking up behind it.
  for (const { domain: brand } of brands.slice(0, MAX_BRANDS)) {
    const r = await fetchBrandMentions(brand, limit);
    if (r.error) { errors[brand] = r.error; continue; }
    try {
      await rawExec(`DELETE FROM "LinkMention" WHERE userId = ? AND brand = ?`, userId, brand);
      for (const row of r.rows || []) {
        await rawExec(
          `INSERT INTO "LinkMention" (id, userId, brand, urlFrom, domainFrom, title, anchor, drFrom, firstSeen, urlTo, dofollow, fetchedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          rid(), userId, brand, row.url, row.domain,
          String(row.title ?? ""), "", 0,
          // firstSeen = when *we* saw the mention, not a link-index first-seen date.
          new Date().toISOString().slice(0, 10), "", "",
          // No link was verified — dofollow stays at its default but the empty anchor tells the
          // UI this row is a mention, not a confirmed backlink.
          1, new Date().toISOString());
        saved++;
      }
    } catch (e) { errors[brand] = String((e as Error)?.message ?? e); }
  }
  return NextResponse.json({ ok: true, saved, brandsChecked: brands.length, errors });
}
