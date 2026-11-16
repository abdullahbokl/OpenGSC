import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import {
  drainSync, healthCheck, isLinkTrackerConfigured, linkTrackerConfig, pendingSyncCount,
} from "@/lib/linktracker/client";

// GET  — is a registry configured (and is it answering)? Credentials never travel back.
// POST — `action: "test"` checks what was TYPED (so a wrong credential never gets saved);
//        `action: "sync"` drains the mirror queue now.

export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await workspaceUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const configured = await isLinkTrackerConfigured(userId);
  if (!configured) return NextResponse.json({ configured: false, healthy: false, pending: await pendingSyncCount() });
  const cfg = await linkTrackerConfig(userId);
  if (!cfg) return NextResponse.json({ configured: false, healthy: false, pending: await pendingSyncCount() });
  const health = await healthCheck(cfg);
  return NextResponse.json({ configured: true, healthy: health.ok, detail: health.detail, pending: await pendingSyncCount() });
}

export async function POST(req: Request) {
  const userId = await workspaceUserId("write");
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action ?? "").trim();

  if (action === "test") {
    const url = String(body?.url ?? "").trim() || "http://127.0.0.1:4030";
    const email = String(body?.email ?? "").trim();
    const password = String(body?.password ?? "").trim();
    if (!email || !password) return NextResponse.json({ ok: false, detail: "email and password required" });
    const health = await healthCheck({ baseUrl: url.replace(/\/+$/, ""), email, password });
    return NextResponse.json(health);
  }

  if (action === "sync") {
    const result = await drainSync(userId);
    return NextResponse.json(result);
  }

  return NextResponse.json({ error: "bad_action" }, { status: 400 });
}
