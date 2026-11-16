// AI outreach drafting + the approval gate, all server-side.
//
// The invariant this module protects: AN AI DRAFT IS NEVER A MESSAGE. A draft exists as text
// with status "draft"; only an explicit owner action moves it to approved/rejected; only an
// explicit "I sent this manually" confirmation (confirmSent) moves the prospect to `contacted`,
// and that confirmation goes through the same daily-cap check as every other path to
// `contacted`. Nothing here transmits anything: no SMTP, no background delivery, no automatic
// follow-ups. Drafting rides the app's standard AI resolution (resolveAiCreds — Ollama Cloud
// by default) so the operator's configured provider is used, never a hardcoded one.

import { prisma } from "@/lib/prisma";
import { getUserSettings, resolveAiCreds } from "@/lib/mcp/shared";
import { fetchLLM } from "@/lib/llm";
import { scrapePage } from "@/lib/seo/scrape";
import { normalizeProspectDomain } from "./types";

export const DRAFT_KINDS = ["initial", "followup1", "followup2"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

export const DRAFT_STATUSES = ["draft", "approved", "rejected"] as const;

const DEFAULT_DAILY_CAP = 4;
const MAX_DAILY_CAP = 10;

/** The daily outreach cap: how many prospects may move to `contacted` per UTC day. Stored in
 *  the settings mirror (`seoOutreachDailyCap`, synced by SeoKeysSync) so the browser can offer
 *  a control; the server reads the same mirror, so a background caller cannot bypass it. */
export async function outreachDailyCap(userId: string): Promise<number> {
  const s = await getUserSettings(userId);
  const n = Number(s.seoOutreachDailyCap);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_DAILY_CAP;
  return Math.min(MAX_DAILY_CAP, Math.floor(n));
}

/** How many prospects this owner moved to `contacted` since UTC midnight — the number the cap
 *  counts. Pure given the timestamps, so the boundary logic is testable without a database. */
export function countContactedToday(now: Date, contactedTimestamps: Date[]): number {
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return contactedTimestamps.filter(t => t.getTime() >= dayStart).length;
}

export class OutreachCapReached extends Error {
  constructor(readonly used: number, readonly cap: number) {
    super(`outreach_cap_reached: ${used}/${cap} manual outreach confirmations already recorded today (UTC)`);
    this.name = "OutreachCapReached";
  }
}

/** Throw when the owner is at their daily cap. Called from the one choke point every path to
 *  `contacted` shares — the service's stage-transition code — so the UI, the API and MCP all
 *  hit the same wall. */
export async function assertOutreachCap(userId: string, now = new Date()): Promise<void> {
  const cap = await outreachDailyCap(userId);
  const events = await prisma.outreachStageEvent.findMany({
    where: { userId, toStage: "contacted" },
    select: { createdAt: true },
  });
  const used = countContactedToday(now, events.map(e => e.createdAt));
  if (used >= cap) throw new OutreachCapReached(used, cap);
}

// ─── generation ───────────────────────────────────────────────────────────────────────────────

interface DraftContent {
  subject: string;
  body: string;
  rationale: string;
}

export function parseDrafts(raw: string | null): { initial: DraftContent; followups: DraftContent[] } | null {
  if (!raw?.trim()) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const read = (v: unknown): DraftContent | null => {
    const o = (v ?? {}) as Record<string, unknown>;
    const body = String(o.body ?? "").trim();
    if (!body) return null;
    return {
      subject: String(o.subject ?? "").trim().slice(0, 300),
      body: body.slice(0, 8000),
      rationale: String(o.rationale ?? "").trim().slice(0, 1000),
    };
  };
  const initial = read(obj.initial);
  if (!initial) return null;
  const fu = Array.isArray(obj.followups) ? obj.followups : [];
  const followups = fu.map(read).filter((d): d is DraftContent => !!d).slice(0, 2);
  return { initial, followups };
}

export interface GeneratedDrafts {
  drafts: { id: string; kind: DraftKind; subject: string; body: string; rationale: string }[];
  model: string;
  groundingWords: number;
}

/** Draft personalized outreach for one prospect. Requires the prospect to be qualified or
 *  ready — discovery output is not pitched blind. Grounds the model in the prospect's ACTUAL
 *  page content (fetched live), so "why you" claims cite the real page; when the page cannot
 *  be read the prompt says so and the model is instructed to keep claims generic rather than
 *  invent page details. */
export async function generateDrafts(userId: string, prospectId: string): Promise<GeneratedDrafts> {
  const prospect = await prisma.outreachProspect.findFirst({ where: { id: prospectId, userId } });
  if (!prospect) throw new Error("prospect_not_found");
  if (prospect.stage !== "qualified" && prospect.stage !== "ready") throw new Error("prospect_not_qualified");

  const domain = normalizeProspectDomain(prospect.domain);
  const pageUrl = prospect.sourceUrl || `https://${domain}`;
  let grounding = "";
  let groundingWords = 0;
  try {
    const page = await scrapePage(pageUrl);
    if (page.ok && !page.boilerplateOnly) {
      grounding = (page.textSample || "").slice(0, 4000);
      groundingWords = page.contentWords;
    }
  } catch { /* grounding stays empty — the prompt says what it knows */ }

  const creds = await resolveAiCreds(userId);
  const prompt = [
    "You are drafting a personalized backlink-outreach message for a site owner.",
    "Rules:",
    "- Ground every 'why you' claim in the ACTUAL page content provided. If the page content is",
    "  empty or too thin, say why you are reaching out in general terms — NEVER invent page",
    "  details, statistics, or articles that are not in the provided content.",
    "- Honest and specific; no flattery clichés, no fake urgency, no template greetings that",
    "  ignore the site.",
    "- Mention our page once, naturally, as a resource that fits what they already publish.",
    "- 100-150 words for the initial message; follow-ups 60-90 words each.",
    "",
    `Their site: ${domain}`,
    prospect.sourceTitle ? `Page title: ${prospect.sourceTitle}` : "",
    `Our target page: ${prospect.targetAsset || "(see link in message)"}`,
    `Keyword/topic context: ${prospect.discoveryQuery || prospect.pitchAngle || "(none recorded)"}`,
    prospect.qualReason ? `Why this prospect was qualified: ${prospect.qualReason}` : "",
    "",
    grounding ? `Page content (markdown sample):\n${grounding}` : "Page content: (could not be read — keep claims generic)",
    "",
    'Return ONLY a JSON object: {"initial":{"subject":"...","body":"...","rationale":"why this angle"},"followups":[{"subject":"...","body":"...","rationale":"..."},...] with at most 2 follow-ups}',
  ].filter(Boolean).join("\n");

  const raw = await fetchLLM(prompt, creds.aiProvider, creds.aiApiKey, 2048, creds.model, creds.aiBaseUrl, 0.4);
  const parsed = parseDrafts(raw);
  if (!parsed) throw new Error("draft_generation_failed");

  const rows: { kind: DraftKind; content: DraftContent }[] = [
    { kind: "initial", content: parsed.initial },
    ...parsed.followups.map((content, i) => ({ kind: (["followup1", "followup2"] as DraftKind[])[i], content })),
  ];
  const drafts = [];
  for (const { kind, content } of rows) {
    drafts.push(await prisma.outreachDraft.create({
      data: {
        userId,
        prospectId: prospect.id,
        kind,
        subject: content.subject,
        body: content.body,
        rationale: content.rationale,
        model: `${creds.aiProvider}${creds.model ? `:${creds.model}` : ""}`,
      },
    }));
  }
  return {
    drafts: drafts.map(d => ({ id: d.id, kind: d.kind as DraftKind, subject: d.subject, body: d.body, rationale: d.rationale })),
    model: drafts[0]?.model ?? "",
    groundingWords,
  };
}

// ─── the gate ─────────────────────────────────────────────────────────────────────────────────

export async function approveDraft(userId: string, draftId: string): Promise<void> {
  const draft = await prisma.outreachDraft.findFirst({ where: { id: draftId, userId } });
  if (!draft) throw new Error("draft_not_found");
  if (draft.status === "rejected") throw new Error("draft_rejected");
  await prisma.outreachDraft.update({
    where: { id: draftId },
    data: { status: "approved", approvedAt: draft.status === "approved" ? draft.approvedAt : new Date() },
  });
}

export async function rejectDraft(userId: string, draftId: string): Promise<void> {
  const draft = await prisma.outreachDraft.findFirst({ where: { id: draftId, userId } });
  if (!draft) throw new Error("draft_not_found");
  await prisma.outreachDraft.update({ where: { id: draftId }, data: { status: "rejected" } });
}

export interface ConfirmSentResult {
  prospectId: string;
  stage: string;
}

/** The operator confirms they sent the message by hand. This is the ONLY path an AI draft has
 *  toward the `contacted` stage, it requires an APPROVED draft, and the stage transition goes
 *  through the service — where the daily cap is enforced. */
export async function confirmSent(userId: string, draftId: string): Promise<ConfirmSentResult> {
  const draft = await prisma.outreachDraft.findFirst({ where: { id: draftId, userId } });
  if (!draft) throw new Error("draft_not_found");
  if (draft.status !== "approved") throw new Error("draft_not_approved");
  const prospect = await prisma.outreachProspect.findFirst({ where: { id: draft.prospectId, userId } });
  if (!prospect) throw new Error("prospect_not_found");
  if (prospect.stage === "contacted" || prospect.stage === "replied" || prospect.stage === "negotiating" || prospect.stage === "won") {
    return { prospectId: prospect.id, stage: prospect.stage }; // already past contacted — nothing to redo
  }
  const { updateOutreachProspect } = await import("./service");
  const updated = await updateOutreachProspect(userId, prospect.id, {
    stage: "contacted",
    stageNote: `manual send confirmed (draft ${draft.id.slice(0, 8)}, ${draft.kind})`,
  });
  return { prospectId: updated.id, stage: updated.stage };
}

export async function listDrafts(userId: string, prospectId: string) {
  return prisma.outreachDraft.findMany({
    where: { userId, prospectId },
    orderBy: { createdAt: "desc" },
    take: 60,
  });
}
