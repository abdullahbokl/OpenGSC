import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { approveDraft, confirmSent, generateDrafts, listDrafts, OutreachCapReached, rejectDraft } from "@/lib/outreach/drafts";

// Draft lifecycle — the approval gate lives here, server-side:
//   POST  {prospectId}              generate drafts (AI; text only, status "draft")
//   PATCH {id, action}              approve | reject | confirmSent
//   GET   ?prospectId=...           list drafts
//
// confirmSent is the ONLY path from an approved draft to the prospect's `contacted` stage, and
// it flows through the service — where the daily cap is enforced. There is no send endpoint:
// the operator sends from their own mailbox, by hand.

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const prospectId = new URL(req.url).searchParams.get("prospectId") ?? "";
  if (!prospectId) return NextResponse.json({ error: "prospect_required" }, { status: 400 });
  try {
    return NextResponse.json({ drafts: await listDrafts(userId, prospectId) });
  } catch {
    return NextResponse.json({ drafts: [], notMigrated: true });
  }
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const prospectId = String(body?.prospectId ?? "").trim();
  if (!prospectId) return NextResponse.json({ error: "prospect_required" }, { status: 400 });
  try {
    return NextResponse.json(await generateDrafts(userId, prospectId), { status: 201 });
  } catch (error) {
    const message = String((error as Error)?.message ?? "draft_failed");
    return NextResponse.json({ error: message }, { status: message.endsWith("_not_found") || message === "prospect_not_qualified" ? 404 : 502 });
  }
}

export async function PATCH(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const id = String(body?.id ?? "").trim();
  const action = String(body?.action ?? "").trim();
  if (!id || !["approve", "reject", "confirmSent"].includes(action)) {
    return NextResponse.json({ error: "bad_action" }, { status: 400 });
  }
  try {
    if (action === "approve") await approveDraft(userId, id);
    else if (action === "reject") await rejectDraft(userId, id);
    else return NextResponse.json(await confirmSent(userId, id));
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof OutreachCapReached) {
      return NextResponse.json({ error: error.message, used: error.used, cap: error.cap }, { status: 429 });
    }
    const message = String((error as Error)?.message ?? "draft_error");
    return NextResponse.json({ error: message }, { status: message.endsWith("_not_found") ? 404 : 400 });
  }
}
