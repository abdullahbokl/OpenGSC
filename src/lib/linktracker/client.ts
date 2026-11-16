// Link Tracker (self-hosted Swappsy registry) client + outbound mirror queue.
//
// OpenGSC stays the AUTHORITATIVE record: SiteBacklink, its verification results and the
// purchase provenance are never derived from Link Tracker. This client only PUSHES: a
// placement row (one per published placement), and an optional lost→removed status write-back.
// The registry is complementary — when it is unreachable, rows queue in LinkTrackerSync and
// drain later; nothing in OpenGSC's own flow waits on it or fails because of it.
//
// Config follows the same env-wins-over-mirror pattern as the other provider integrations:
//   env:  OPENGSC_LINKTRACKER_URL / OPENGSC_LINKTRACKER_EMAIL / OPENGSC_LINKTRACKER_PASSWORD
//   mirror: seoBaseUrl_linktracker / seoLinkTrackerEmail / seoKey_linktracker
// The password is the registry's admin password and lives only in env or the settings mirror —
// it never travels back to the browser.

import { getUserSettings } from "@/lib/mcp/shared";
import { rawQuery } from "@/lib/db/raw";

type CountRow = { n: number };

export const LINKTRACKER_DEFAULT_URL = "http://127.0.0.1:4030";

export interface LinkTrackerConfig {
  baseUrl: string;
  email: string;
  password: string;
}

export async function linkTrackerConfig(userId: string): Promise<LinkTrackerConfig | null> {
  const s = await getUserSettings(userId);
  const baseUrl = (process.env.OPENGSC_LINKTRACKER_URL ?? "").trim()
    || String(s.seoBaseUrl_linktracker ?? "").trim()
    || LINKTRACKER_DEFAULT_URL;
  const email = (process.env.OPENGSC_LINKTRACKER_EMAIL ?? "").trim()
    || String(s.seoLinkTrackerEmail ?? "").trim();
  const password = (process.env.OPENGSC_LINKTRACKER_PASSWORD ?? "").trim()
    || String(s.seoKey_linktracker ?? "").trim();
  if (!email || !password) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), email, password };
}

export function isLinkTrackerConfigured(userId: string): Promise<boolean> {
  return linkTrackerConfig(userId).then(c => c !== null);
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────────────────────

interface TokenCache { token: string; exp: number }
let cached: TokenCache | null = null;

function jwtExp(token: string): number {
  try {
    const payload = token.split(".")[1];
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return Number(json.exp ?? 0) * 1000;
  } catch {
    return Date.now() + 24 * 3600_000;
  }
}

export class LinkTrackerError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "LinkTrackerError";
  }
}

async function login(cfg: LinkTrackerConfig): Promise<string> {
  const res = await fetch(`${cfg.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: cfg.email, password: cfg.password }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new LinkTrackerError(res.status, `linktracker login ${res.status}`);
  const body = await res.json() as { data?: { token?: string }; token?: string };
  const token = body.data?.token ?? body.token;
  if (!token) throw new LinkTrackerError(res.status, "linktracker login: no token in answer");
  return token;
}

async function authedFetch(cfg: LinkTrackerConfig, path: string, init: RequestInit = { headers: {} }, retried = false): Promise<Response> {
  if (!cached || cached.exp - 60_000 < Date.now()) {
    cached = { token: await login(cfg), exp: 0 };
    cached.exp = jwtExp(cached.token);
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${cached.token}`);
  const res = await fetch(`${cfg.baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401 && !retried) {
    cached = null; // expired or rotated — one fresh login, then give up
    return authedFetch(cfg, path, init, true);
  }
  return res;
}

async function body<T>(res: Response): Promise<T> {
  const json = await res.json().catch(() => ({})) as { data?: T } & T;
  // The registry wraps answers in {success, data}; older shapes may be flat — accept both.
  return (json.data !== undefined ? json.data : json) as T;
}

import { findByRef, placementRef, type TrackerLink } from "./refs";

export { findByRef, placementRef };
export type { TrackerLink };

export interface UpsertFields {
  placementUrl: string;
  targetUrl?: string;
  anchorText?: string;
  partnerName?: string;
  linkType?: string;
  particular?: string;
  status?: string;
}

async function listLinks(cfg: LinkTrackerConfig): Promise<TrackerLink[]> {
  const res = await authedFetch(cfg, "/api/links");
  if (!res.ok) throw new LinkTrackerError(res.status, `linktracker list ${res.status}`);
  const data = await body<TrackerLink[] | { links?: TrackerLink[] }>(res);
  return Array.isArray(data) ? data : data.links ?? [];
}



/** One idempotent write: POST when the ref is new, PATCH when it exists. Duplicate submits,
 *  retried drains and repeated events all land on the same single registry row. */
export async function upsertPlacement(userId: string, externalRef: string, fields: UpsertFields): Promise<{ ok: true; id: number; created: boolean } | { ok: false; error: string }> {
  const cfg = await linkTrackerConfig(userId);
  if (!cfg) return { ok: false, error: "linktracker_not_configured" };
  try {
    const links = await listLinks(cfg);
    const existing = findByRef(links, externalRef);
    const payload = {
      placementUrl: fields.placementUrl,
      targetUrl: fields.targetUrl ?? "",
      anchorText: fields.anchorText ?? "",
      partnerName: fields.partnerName ?? "",
      linkType: fields.linkType ?? "",
      particular: fields.particular ?? "",
      notes: externalRef,
      ...(fields.status ? { status: fields.status } : {}),
    };
    if (existing) {
      const res = await authedFetch(cfg, `/api/links/${existing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return { ok: false, error: `linktracker patch ${res.status}` };
      return { ok: true, id: existing.id, created: false };
    }
    const res = await authedFetch(cfg, "/api/links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, error: `linktracker post ${res.status}` };
    const link = await body<TrackerLink>(res);
    // The registry creates every row as "pending" by design; a mirror that already knows the
    // verdict (an outreach win the human confirmed) carries it over in one extra PATCH.
    if (fields.status && fields.status !== "pending") {
      const patch = await authedFetch(cfg, `/api/links/${link.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: fields.status }),
      });
      if (!patch.ok) return { ok: false, error: `linktracker status patch ${patch.status}` };
    }
    return { ok: true, id: link.id, created: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

export async function updateStatus(userId: string, externalRef: string, status: "pending" | "live" | "removed"): Promise<{ ok: true } | { ok: false; error: string }> {
  const cfg = await linkTrackerConfig(userId);
  if (!cfg) return { ok: false, error: "linktracker_not_configured" };
  try {
    const links = await listLinks(cfg);
    const existing = findByRef(links, externalRef);
    if (!existing) return { ok: true }; // nothing mirrored under that ref — nothing to update
    const res = await authedFetch(cfg, `/api/links/${existing.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) return { ok: false, error: `linktracker patch ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

export async function healthCheck(cfg: LinkTrackerConfig): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${cfg.baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, detail: `health ${res.status}` };
    await login(cfg);
    return { ok: true, detail: "registry reachable, credentials accepted" };
  } catch (e) {
    return { ok: false, detail: String((e as Error)?.message ?? e) };
  }
}

// ─── the queue ────────────────────────────────────────────────────────────────────────────────

export interface MirrorPlacement {
  placementUrl: string;
  targetUrl?: string;
  anchorText?: string;
  partnerName?: string;
  linkType?: string;
  particular?: string;
  status?: string;
}

/** Queue a placement mirror. Written locally FIRST, drained to the registry LATER — the caller
 *  never blocks on the registry and never loses the request. externalRef is the dedup key on
 *  both sides. */
export async function enqueuePlacement(userId: string, externalRef: string, placement: MirrorPlacement): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  await prisma.linkTrackerSync.upsert({
    where: { externalRef },
    create: { userId, externalRef, kind: "placement", payload: JSON.stringify(placement) },
    update: { kind: "placement", payload: JSON.stringify(placement), syncedAt: null, attempts: 0, lastError: "" },
  });
}

export async function enqueueStatus(userId: string, externalRef: string, status: "pending" | "live" | "removed"): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  await prisma.linkTrackerSync.upsert({
    where: { externalRef },
    create: { userId, externalRef, kind: "status", payload: JSON.stringify({ status }) },
    update: { kind: "status", payload: JSON.stringify({ status }), syncedAt: null, attempts: 0, lastError: "" },
  });
}

/** Status write-back that fires ONCE per placement verdict: an already-synced row is left
 *  alone, so a recurring scheduler pass cannot resurrect old verdicts or re-queue forever. */
export async function enqueueStatusOnce(userId: string, externalRef: string, status: "pending" | "live" | "removed"): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  const existing = await prisma.linkTrackerSync.findUnique({ where: { externalRef }, select: { syncedAt: true } });
  if (existing?.syncedAt) return;
  await enqueueStatus(userId, externalRef, status);
}

const DRAIN_BATCH = 10;
const MAX_ATTEMPTS = 5;

export interface DrainResult { drained: number; failed: number; remaining: number }

/** Drain queued mirrors. Errors are RECORDED, not thrown — the registry's problems must never
 *  become OpenGSC's request failures. Returns what happened so routes can report honestly. */
export async function drainSync(userId?: string): Promise<DrainResult> {
  const { prisma } = await import("@/lib/prisma");
  const rows = await prisma.linkTrackerSync.findMany({
    where: { syncedAt: null, attempts: { lt: MAX_ATTEMPTS }, ...(userId ? { userId } : {}) },
    orderBy: { createdAt: "asc" },
    take: DRAIN_BATCH,
  });
  let drained = 0;
  let failed = 0;
  const seenOwners = new Map<string, string>(); // userId -> placement ref for the lost pass
  for (const row of rows) {
    const owner = row.userId;
    if (!seenOwners.has(owner)) seenOwners.set(owner, row.externalRef);
    const cfg = await linkTrackerConfig(owner);
    if (!cfg) {
      await prisma.linkTrackerSync.update({
        where: { id: row.id },
        data: { attempts: row.attempts + 1, lastError: "linktracker_not_configured" },
      });
      failed++;
      continue;
    }
    try {
      if (row.kind === "status") {
        const { status } = JSON.parse(row.payload) as { status?: "pending" | "live" | "removed" };
        const r = await updateStatus(owner, row.externalRef, status ?? "pending");
        if (!r.ok) throw new Error(r.error);
      } else {
        const placement = JSON.parse(row.payload) as MirrorPlacement;
        const r = await upsertPlacement(owner, row.externalRef, placement);
        if (!r.ok) throw new Error(r.error);
      }
      await prisma.linkTrackerSync.update({ where: { id: row.id }, data: { syncedAt: new Date(), lastError: "" } });
      drained++;
    } catch (e) {
      await prisma.linkTrackerSync.update({
        where: { id: row.id },
        data: { attempts: row.attempts + 1, lastError: String((e as Error)?.message ?? e).slice(0, 500) },
      });
      failed++;
    }
  }
  let remaining = 0;
  try {
    const pending = await rawQuery<CountRow[]>(
      `SELECT COUNT(*) AS n FROM "LinkTrackerSync" WHERE "syncedAt" IS NULL AND "attempts" < ?`,
      MAX_ATTEMPTS,
    );
    remaining = Number(pending?.[0]?.n ?? 0);
  } catch { /* table not pushed yet — zero */ }
  return { drained, failed, remaining };
}

/** Queued mirrors that never reached the registry and are out of attempts — surfaced so an
 *  operator can see the backlog instead of assuming sync succeeded. */
export async function pendingSyncCount(): Promise<number> {
  try {
    const rows = await rawQuery<CountRow[]>(
      `SELECT COUNT(*) AS n FROM "LinkTrackerSync" WHERE "syncedAt" IS NULL AND "attempts" < ?`,
      MAX_ATTEMPTS,
    );
    return Number(rows?.[0]?.n ?? 0);
  } catch {
    return 0;
  }
}
