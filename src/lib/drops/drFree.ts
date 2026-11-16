// Server-side Domain Rating (Ahrefs' 0–100 scale) via the owner's GoAnyAPI gateway — the drops
// button's path. Ahrefs itself was removed from the product, so the old free-endpoint fetch is
// gone; GoAnyAPI (a gateway the user configures under Settings, reselling the same figure) is
// the only remaining DR source, and its key is resolved from the owner's server settings so the
// drops catalogue does not depend on this particular browser having typed anything.
//
// DrCache is shared with /api/dr (7-day TTL): whichever path fetched first, the other reuses.
// GoAnyAPI bills per call (~2 credits/domain), so the batch cap stays small — the cache, not
// the wallet, absorbs the bulk of a big catalogue.

import { rawQuery } from "@/lib/db/raw";
import { runUpsert } from "@/lib/db/upsert";
import { recordDrSnapshots } from "@/lib/seo/drHistory";
import { getOwnerSettings } from "@/lib/engineKeysServer";
import { goanyDr } from "@/lib/seo/goanyapi";

const TTL_MS = 7 * 24 * 3600 * 1000;
const BATCH_CAP = 10;

/** The owner's GoAnyAPI key — the only DR source after the Ahrefs removal. */
export async function resolveDrKey(userId: string): Promise<string> {
  const s = await getOwnerSettings(userId);
  return String(s.seoKey_goanyapi || "").trim();
}

export interface DrResult {
  ratings: Record<string, number>;
  keyFound: boolean;
}

/**
 * DR for a batch of domains, from cache where fresh, fetched where not.
 *
 * `keyFound: false` means nothing could be fetched and nothing new will arrive — the caller
 * must say so out loud rather than show "Обновлено: 0", which reads as a broken button.
 *
 * `force` is the monthly-walk semantics: the caller knows this domain owes a new month's
 * DrSnapshot point, and the 7-day value cache must not delay that point by up to its whole
 * TTL. Cached values still seed `ratings` (a failed fetch then leaves the old number rather
 * than nothing), but nothing is treated as fresh — every domain is re-measured.
 */
export async function drForDomains(
  userId: string,
  domains: string[],
  opts: { force?: boolean } = {},
): Promise<DrResult> {
  const unique = [...new Set(domains.map(d => d.trim().toLowerCase().replace(/^www\./, "")))].filter(Boolean);
  if (!unique.length) return { ratings: {}, keyFound: false };

  const ratings: Record<string, number> = {};
  let cached: Array<{ domain: string; dr: number | string; checkedAt: string }> = [];
  try {
    cached = await rawQuery(
      `SELECT domain, dr, checkedAt FROM "DrCache" WHERE domain IN (${unique.map(() => "?").join(",")})`, ...unique);
  } catch { /* table missing until prisma db push */ }
  const fresh = new Set<string>();
  for (const r of cached) {
    ratings[r.domain] = Number(r.dr);
    if (!opts.force && Date.now() - new Date(r.checkedAt).getTime() < TTL_MS) {
      fresh.add(r.domain);
    }
  }

  const apiKey = await resolveDrKey(userId);
  if (!apiKey) return { ratings, keyFound: false };

  const missing = unique.filter(d => !fresh.has(d)).slice(0, BATCH_CAP);
  let i = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (i < missing.length) {
      const domain = missing[i++];
      const dr = (await goanyDr(apiKey, domain)).data?.dr ?? null;
      if (dr == null) continue;
      ratings[domain] = dr;
      try {
        await runUpsert({
          table: "DrCache",
          conflict: ["domain"],
          values: { domain, dr, checkedAt: new Date().toISOString() },
          update: { dr: "set", checkedAt: "set" },
        });
        // Fresh measurement → this month's DrSnapshot row: the drops catalogue keeps
        // accumulating its own DR history.
        await recordDrSnapshots([{ domain, dr, source: "goanyapi" }]);
      } catch { /* cache best-effort, same as /api/dr */ }
    }
  }));

  return { ratings, keyFound: true };
}
