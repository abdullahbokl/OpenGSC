// Native prospect discovery for the Outreach Workspace — SearXNG finds candidate pages, the
// user's configured AI provider (Ollama Cloud by default, through the standard resolveAiCreds
// path) scores relevance, and the survivors land in OutreachProspect through the existing
// service (so dedup-by-domain and the stage event log keep working unchanged).
//
// Honesty rules this module exists to enforce:
//   • A search result is NOT a backlink opportunity. It is a candidate the AI found plausible.
//     Every prospect carries its score and the reason text verbatim, so the operator sees the
//     qualification's actual words, never a fabricated metric.
//   • When the AI answer cannot be parsed, every candidate is saved UNSCORED
//     (qualScore 0, reason "qualification_unavailable") rather than guessed.
//   • Competitors flagged by the qualification pass are dropped, not saved.

import { prisma } from "@/lib/prisma";
import { normalizeProspectDomain } from "./types";
import { resolveAiCreds } from "@/lib/mcp/shared";
import { fetchLLM } from "@/lib/llm";
import { searxngSearch } from "@/lib/seo/searxng";

export type DiscoveryPattern = "resource" | "listicle" | "guest_post" | "article";
const PATTERNS: DiscoveryPattern[] = ["resource", "listicle", "guest_post", "article"];

export function isDiscoveryPattern(v: unknown): v is DiscoveryPattern {
  return PATTERNS.includes(v as DiscoveryPattern);
}

// One query per pattern — SearXNG merges engines itself, so three good queries beat ten
// overlapping ones. Operators cast a wide net for pages that accept outside contributions.
export function buildDiscoveryQueries(keyword: string, pattern: DiscoveryPattern): string[] {
  const k = keyword.trim();
  if (!k) return [];
  switch (pattern) {
    case "resource":
      return [`${k} intitle:resources OR inurl:resources links`, `${k} useful resources page`];
    case "listicle":
      return [`best ${k} tools list`, `${k} top websites roundup blog`];
    case "guest_post":
      return [`${k} "write for us"`, `${k} "guest post" guidelines`];
    case "article":
      return [`${k} blog inurl:blog`, `${k} articles sites accepting contributions`];
  }
}

export interface Candidate {
  url: string;
  title: string;
  snippet: string;
  domain: string;
}

/** Drop the operator's own properties, results already saved as prospects, repeats inside one
 *  batch, and rows whose URL carries login/asset noise. Pure — the testable half of discovery. */
export function filterCandidates(
  results: Candidate[],
  opts: { ownDomains: Set<string>; existingDomains: Set<string>; excludeDomains?: string[] },
): Candidate[] {
  const exclude = new Set((opts.excludeDomains ?? []).map(d => normalizeProspectDomain(d)).filter(Boolean));
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const r of results) {
    const url = String(r.url ?? "").trim();
    const domain = normalizeProspectDomain(r.domain || url);
    if (!url || !domain || !domain.includes(".")) continue;
    if (opts.ownDomains.has(domain)) continue;
    if (opts.existingDomains.has(domain)) continue;
    if (exclude.has(domain)) continue;
    if (seen.has(domain)) continue; // one prospect per domain per run — the pitch is per-site
    if (/\/(login|signin|signup|register|wp-admin|cart)(\/|$)/i.test(url)) continue;
    seen.add(domain);
    out.push({ ...r, domain });
  }
  return out;
}

export interface Qualification {
  url: string;
  score: number;
  reason: string;
  competitor: boolean;
}

const SCORE_MIN = 0;
const SCORE_MAX = 10;
/** Below this the prospect is saved anyway? No — dropped: the operator asked for qualified
 *  prospects, and an honest "the AI was unsure" row with score 0 still arrives when the AI
 *  itself could not be reached (see parseQualification's unavailable branch). */
export const QUALIFY_THRESHOLD = 4;

/** Parse the model's answer. ANY failure degrades to "qualification_unavailable" for every
 *  candidate — the pipeline keeps running and the operator decides by hand, instead of the
 *  module inventing scores it does not have. Pure — the testable half of qualification. */
export function parseQualification(raw: string | null, candidates: Candidate[]): Qualification[] {
  const unavailable = candidates.map(c => ({ url: c.url, score: 0, reason: "qualification_unavailable", competitor: false }));
  if (!raw || !raw.trim()) return unavailable;
  // Models like to wrap JSON in prose or fences; take the outermost bracketed block.
  const start = Math.min(...["[", "{"].map(ch => { const i = raw.indexOf(ch); return i < 0 ? Number.MAX_SAFE_INTEGER : i; }));
  const end = Math.max(raw.lastIndexOf("]"), raw.lastIndexOf("}"));
  if (start >= end || start === Number.MAX_SAFE_INTEGER) return unavailable;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return unavailable;
  }
  const rows = Array.isArray(parsed) ? parsed : (parsed as { qualifications?: unknown[] })?.qualifications;
  if (!Array.isArray(rows)) return unavailable;
  const byUrl = new Map(candidates.map(c => [c.url, c]));
  const out: Qualification[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const r = (row ?? {}) as Record<string, unknown>;
    const url = String(r.url ?? "").trim();
    if (!byUrl.has(url) || seen.has(url)) continue;
    seen.add(url);
    const nScore = Number(r.score);
    const score = Number.isFinite(nScore) ? Math.min(SCORE_MAX, Math.max(SCORE_MIN, Math.round(nScore * 10) / 10)) : 0;
    out.push({
      url,
      score,
      reason: String(r.reason ?? "").trim().slice(0, 300),
      competitor: r.competitor === true || /^(true|yes)$/i.test(String(r.competitor ?? "")),
    });
  }
  // Candidates the model skipped stay in the answer rather than vanishing: unscored, not judged.
  for (const c of candidates) if (!seen.has(c.url)) out.push({ url: c.url, score: 0, reason: "not_scored_by_model", competitor: false });
  return out;
}

export interface DiscoveryInput {
  campaignId?: string;
  keyword: string;
  targetAsset?: string;
  pattern: DiscoveryPattern;
  limit?: number;
  excludeDomains?: string[];
}

export interface DiscoveryResult {
  queries: string[];
  searched: number;
  candidates: number;
  qualified: number;
  created: number;
  duplicates: number;
  droppedCompetitors: number;
  prospects: { id: string; domain: string; qualScore: number; qualReason: string }[];
  error?: string;
}

const MAX_PROSPECTS_PER_RUN = 10;

export async function discoverProspects(userId: string, input: DiscoveryInput): Promise<DiscoveryResult> {
  const keyword = String(input.keyword ?? "").trim();
  const pattern = input.pattern;
  const queries = buildDiscoveryQueries(keyword, pattern);
  const out: DiscoveryResult = { queries, searched: 0, candidates: 0, qualified: 0, created: 0, duplicates: 0, droppedCompetitors: 0, prospects: [] };
  if (!queries.length) throw new Error("keyword_required");

  // SearXNG only — the free default. A paid provider needs no new code path here: the SERP
  // abstraction's other engines stay available through their own tools, and this module never
  // spends the operator's credits without being told to.
  const results = [];
  for (const q of queries) {
    const res = await searxngSearch("", q, { num: 15 });
    out.searched++;
    if (res.error) continue;
    for (const r of res.results) results.push({ url: r.url, title: r.title, snippet: r.snippet ?? "", domain: r.domain });
  }
  if (!results.length) return { ...out, error: "no_search_results" };

  const [sites, existing] = await Promise.all([
    prisma.site.findMany({ where: { userId }, select: { url: true } }),
    prisma.outreachProspect.findMany({ where: { userId }, select: { domain: true } }),
  ]);
  const ownDomains = new Set(sites.map(s => normalizeProspectDomain(s.url)).filter(Boolean));
  const candidates = filterCandidates(results, {
    ownDomains,
    existingDomains: new Set(existing.map(p => p.domain)),
    excludeDomains: input.excludeDomains,
  });
  out.candidates = candidates.length;
  if (!candidates.length) return { ...out, error: "all_candidates_filtered" };

  // Qualification through the app's own AI resolution — same creds the generation jobs use.
  let qualifications: Qualification[];
  try {
    const creds = await resolveAiCreds(userId);
    const prompt = [
      "You are qualifying backlink-outreach prospects. Given a keyword, our target asset, and",
      "candidate web pages found by a search engine, decide for each candidate:",
      '  score 0-10 — how plausible it is that this SITE accepts outside contributions or links',
      '    (resource pages, curated lists, blogs with guest posts, review sites score high;',
      "     competitors, marketplaces, and pure product pages score 0)",
      "  reason — one sentence, concrete, ≤ 200 characters, citing what the title/snippet shows",
      "  competitor — true when the site sells something directly competing with our target asset",
      "",
      `Keyword: ${keyword}`,
      input.targetAsset ? `Our target asset: ${input.targetAsset}` : "",
      "",
      "Candidates (JSON):",
      JSON.stringify(candidates.map(c => ({ url: c.url, title: c.title, snippet: c.snippet.slice(0, 200) }))),
      "",
      'Answer with ONLY a JSON array: [{"url":"...","score":7,"reason":"...","competitor":false}, ...]',
    ].filter(Boolean).join("\n");
    const raw = await fetchLLM(prompt, creds.aiProvider, creds.aiApiKey, 2048, creds.model, creds.aiBaseUrl, 0.2);
    qualifications = parseQualification(raw, candidates);
  } catch {
    qualifications = parseQualification(null, candidates);
  }

  const byUrl = new Map(candidates.map(c => [c.url, c]));
  const kept = qualifications
    .map(q => ({ q, c: byUrl.get(q.url) }))
    .filter((x): x is { q: Qualification; c: Candidate } => !!x.c)
    .sort((a, b) => b.q.score - a.q.score);
  out.droppedCompetitors = kept.filter(x => x.q.competitor).length;

  for (const { q, c } of kept) {
    if (out.created >= MAX_PROSPECTS_PER_RUN) break;
    if (q.competitor) continue;
    if (q.score < QUALIFY_THRESHOLD && q.reason !== "qualification_unavailable" && q.reason !== "not_scored_by_model") continue;
    out.qualified++;
    const saved = await saveProspect(userId, input, c, q);
    if (saved.created) { out.created++; out.prospects.push({ id: saved.prospect.id, domain: saved.prospect.domain, qualScore: q.score, qualReason: q.reason }); }
    else out.duplicates++;
  }
  return out;
}

async function saveProspect(userId: string, input: DiscoveryInput, c: Candidate, q: Qualification) {
  const { createOutreachProspect } = await import("./service");
  const result = await createOutreachProspect(userId, {
    campaignId: input.campaignId,
    domain: c.domain,
    sourceUrl: c.url,
    sourceTitle: c.title.slice(0, 500),
    targetAsset: input.targetAsset,
    notes: q.reason,
  });
  if (result.created) {
    await prisma.outreachProspect.update({
      where: { id: result.prospect.id },
      data: {
        discoverySource: "searxng",
        discoveryQuery: input.keyword,
        discoveredAt: new Date(),
        qualScore: q.score,
        qualReason: q.reason,
      },
    });
  }
  return result;
}
