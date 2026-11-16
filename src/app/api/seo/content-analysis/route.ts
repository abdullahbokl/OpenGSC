import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { runContentSearch, runSearxngContentSearch } from "@/lib/seo/contentAnalysis";
import { analyzeCitationSentiment } from "@/lib/seo/citationSentimentRun";
import { serpConfigReady } from "@/lib/seo/serpReadiness";
import { DEFAULT_AI_PROVIDER } from "@/lib/providerDefaults";

// POST /api/seo/content-analysis
// body: { keyword, dfsKey?, provider?, aiProvider?, aiApiKey?, aiModel?, aiBaseUrl?,
//         limit?, gl?, hl?, analyze?, scrape?, maxItems? }
// Brand/keyword citations. DataForSEO returns its own connotation counters; the keyless path
// searches with SearXNG and has the configured chat model read each mention, so sentiment no
// longer depends on a commercial key. A failed read is reported as unavailable, never as neutral.
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

    // Mentions are useful on their own; sentiment needs a reader. Without an AI key the list is
    // returned as-is with sentimentAvailable=false, exactly as before this route learned to analyse.
    const aiApiKey = String(b.aiApiKey ?? "");
    if (!aiApiKey || b.analyze === false) return NextResponse.json(out);

    const analysis = await analyzeCitationSentiment(
      out.items,
      keyword,
      {
        provider: String(b.aiProvider ?? DEFAULT_AI_PROVIDER),
        apiKey: aiApiKey,
        model: b.aiModel ? String(b.aiModel) : undefined,
        baseUrl: b.aiBaseUrl ? String(b.aiBaseUrl) : undefined,
      },
      {
        lang: b.hl ? String(b.hl) : undefined,
        scrape: b.scrape === undefined ? undefined : Number(b.scrape),
        maxItems: b.maxItems === undefined ? undefined : Number(b.maxItems),
        maxTokens: b.maxTokens === undefined ? undefined : Number(b.maxTokens),
        concurrency: b.concurrency === undefined ? undefined : Number(b.concurrency),
      },
    );
    return NextResponse.json({
      total: analysis.items.length,
      items: analysis.items,
      source: "searxng",
      sentimentAvailable: analysis.sentimentAvailable,
      analysis: {
        provider: analysis.provider,
        model: analysis.model,
        analyzed: analysis.analyzed,
        unclear: analysis.unclear,
        unanalysed: analysis.unanalysed,
        failedExtraction: analysis.failedExtraction,
        scraped: analysis.scraped,
        cached: analysis.cached,
        error: analysis.error,
      },
    });
  }

  if (!dfsKey) return NextResponse.json({ error: "no_dataforseo_key", items: [], total: 0 }, { status: 400 });
  const out = await runContentSearch(dfsKey, keyword, { limit: b.limit });
  if (out.error) return NextResponse.json({ ...out, items: [], total: 0 }, { status: 502 });
  return NextResponse.json(out);
}
