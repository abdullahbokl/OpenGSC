import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { discoverProspects, isDiscoveryPattern } from "@/lib/outreach/prospecting";

// POST /api/outreach/discover — run one SearXNG + AI qualification pass and save the
// prospects that survive into the existing Outreach Workspace. Free defaults only: SearXNG
// for search, the operator's configured AI provider for scoring. Never fabricates — the
// qualification's own score and reason text land on the prospect row.

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const keyword = String(body?.keyword ?? "").trim();
  if (!keyword) return NextResponse.json({ error: "keyword_required" }, { status: 400 });
  const pattern = body?.pattern ?? "resource";
  if (!isDiscoveryPattern(pattern)) return NextResponse.json({ error: "invalid_pattern" }, { status: 400 });
  try {
    const result = await discoverProspects(userId, {
      campaignId: body?.campaignId ? String(body.campaignId) : undefined,
      keyword,
      targetAsset: body?.targetAsset ? String(body.targetAsset) : undefined,
      pattern,
      excludeDomains: Array.isArray(body?.excludeDomains) ? body.excludeDomains.map(String) : undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = String((error as Error)?.message ?? "discover_failed");
    return NextResponse.json({ error: message }, { status: message === "keyword_required" ? 400 : 500 });
  }
}
