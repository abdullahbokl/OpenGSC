import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { runContentSearch, runSearxngContentSearch } from "@/lib/seo/contentAnalysis";
import { serpConfigReady } from "@/lib/seo/serpReadiness";

// POST /api/seo/content-analysis  { keyword, dfsKey?, provider?, limit?, gl?, hl? }
// Brand/keyword citations. DataForSEO supplies sentiment; the keyless path uses SearXNG mentions.
export async function POST(req: Request) {
  const workspaceId = await workspaceUserId("spend");
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const b = await req.json();
  const keyword = String(b.keyword ?? "").trim();
  const dfsKey = String(b.dfsKey ?? "");
  const provider = String(b.provider ?? (dfsKey ? "dataforseo" : "searxng"));
  if (!keyword) return NextResponse.json({ error: "no_keyword" }, { status: 400 });

  if (provider === "searxng") {
    if (!serpConfigReady("searxng", "")) return NextResponse.json({ error: "no_serp_key", items: [], total: 0 }, { status: 400 });
    const out = await runSearxngContentSearch(keyword, { limit: b.limit, gl: b.gl, hl: b.hl });
    if (out.error) return NextResponse.json({ ...out, items: [], total: 0 }, { status: 502 });
    return NextResponse.json(out);
  }

  if (!dfsKey) return NextResponse.json({ error: "no_dataforseo_key", items: [], total: 0 }, { status: 400 });
  const out = await runContentSearch(dfsKey, keyword, { limit: b.limit });
  if (out.error) return NextResponse.json({ ...out, items: [], total: 0 }, { status: 502 });
  return NextResponse.json(out);
}
