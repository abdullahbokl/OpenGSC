import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { prisma } from "@/lib/prisma";
import { runUpsert } from "@/lib/db/upsert";
import { rawQuery } from "@/lib/db/raw";
import { goanyDr } from "@/lib/seo/goanyapi";
import { recordDrSnapshots } from "@/lib/seo/drHistory";

// GET /api/dr?domains=a.com,b.com — Domain Rating (Ahrefs' 0–100 scale) via the user's own
// GoAnyAPI gateway, the only DR source left after Ahrefs was removed from the product. The
// client sends its key via the `x-goanyapi-key` header (same slot the traffic/ads-intel chips
// use), since keys in this app live in the browser's localStorage, not server-side.
//
// Cached rows (SQLite, 7-day TTL) still serve fine with no key configured — only fetching a
// *new* rating requires one. GoAnyAPI bills per call and rate-limits at roughly 5/s, so the
// batch stays small: whatever it does not cover this round is still served from cache next
// time; spending sixty credits to fill a dashboard nobody asked to refresh is not a trade to
// make on the user's behalf.

const TTL_MS = 7 * 24 * 3600 * 1000;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const shareToken = searchParams.get('shareToken');
  let isAuthorized = !!(await workspaceUserId());
  if (!isAuthorized && shareToken) {
    const site = await prisma.site.findFirst({ where: { shareToken, shareEnabled: true } });
    if (site) isAuthorized = true;
  }
  if (!isAuthorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const goAnyKey = (req.headers.get("x-goanyapi-key") || "").trim();

  const domains = [...new Set(String(searchParams.get("domains") ?? "").split(",")
    .map(s => s.trim().toLowerCase().replace(/^www\./, "")).filter(d => d && d.includes(".")))].slice(0, 250);
  if (!domains.length) return NextResponse.json({ ratings: {} });

  const out: Record<string, { dr: number; checkedAt: string }> = {};
  let cached: { domain: string; dr: number; checkedAt: string }[] = [];
  try {
    cached = await rawQuery(
      `SELECT domain, dr, checkedAt FROM "DrCache" WHERE domain IN (${domains.map(() => "?").join(",")})`, ...domains);
  } catch { /* table missing until prisma db push */ }
  const fresh = new Set<string>();
  for (const r of cached) {
    const age = Date.now() - new Date(r.checkedAt).getTime();
    if (age < TTL_MS) { out[r.domain] = { dr: Number(r.dr), checkedAt: r.checkedAt }; fresh.add(r.domain); }
  }

  const cacheOnly = searchParams.get("cacheOnly") === "1";
  const haveKey = !!goAnyKey;
  const missing = cacheOnly || !haveKey ? [] : domains.filter(d => !fresh.has(d)).slice(0, 10);
  let i = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (i < missing.length) {
      const d = missing[i++];
      const dr = (await goanyDr(goAnyKey, d)).data?.dr ?? null;
      if (dr == null) continue;
      out[d] = { dr, checkedAt: new Date().toISOString() };
      try {
        await runUpsert({
          table: "DrCache",
          conflict: ["domain"],
          values: { domain: d, dr, checkedAt: new Date().toISOString() },
          update: { dr: "set", checkedAt: "set" },
        });
        // A fresh measurement also appends this month's DrSnapshot — the self-accumulated DR
        // history. The monthly key makes repeats idempotent, so no TTL reasoning here.
        await recordDrSnapshots([{ domain: d, dr, source: "goanyapi" }]);
      } catch { /* cache best-effort */ }
    }
  }));

  return NextResponse.json({
    ratings: out,
    attribution: "Domain Rating — Ahrefs DR scale via GoAnyAPI",
    keyConfigured: haveKey,
    source: "goanyapi",
  });
}
