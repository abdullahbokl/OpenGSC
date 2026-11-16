import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { findContact } from "@/lib/outreach/contact";

// POST /api/outreach/contact — inspect one prospect's publicly reachable contact pages and
// store what was found. Only literally-published addresses are stored; nothing found is the
// normal, honest answer and is recorded as `no_contact_found:...` in contactSource.

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const prospectId = String(body?.prospectId ?? "").trim();
  if (!prospectId) return NextResponse.json({ error: "prospect_required" }, { status: 400 });
  try {
    return NextResponse.json(await findContact(userId, prospectId));
  } catch (error) {
    const message = String((error as Error)?.message ?? "contact_failed");
    return NextResponse.json({ error: message }, { status: message.endsWith("_not_found") ? 404 : 500 });
  }
}
