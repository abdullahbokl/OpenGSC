// Pure helpers for the GEO audit's "ollama" engine.
//
// The engine's split of labour: stage 1 collects REAL search results through the app's existing
// SERP integrations (self-hosted SearXNG, or Serper when the user holds a key), opens the most
// promising pages, and hands the numbered source pool to the user's configured AI provider
// (Ollama Cloud on this install) for the grounded answer; stage 2 then runs the standard
// qualitative analysis over the trace. Ollama never "searches" — every URL in the report comes
// from the SERP pool, and every citation the answer makes is checked against that pool, so a
// hallucinated source has nowhere to enter.
//
// Kept I/O-free so the tests run without network or provider shims.

export interface OllamaSource {
  url: string;
  title: string;
  domain: string;
  snippet: string;
}

/**
 * The grounded answer prompt: what an agentic web-search answer would look like, built ONLY
 * from the collected sources. Citation contract is [n] markers matching the numbered pool —
 * mechanically checkable downstream (see citationsFromAnswer), which is what keeps the report's
 * citations real.
 */
export function buildOllamaAnswerPrompt(
  query: string,
  language: string,
  country: string,
  pool: OllamaSource[],
  pageTexts: Map<string, string>,
): string {
  const sourceBlock = pool.map((s, i) => {
    const extract = pageTexts.get(s.url);
    return `[${i + 1}] ${s.domain} — ${s.title || s.url}\n    snippet: ${s.snippet || "(none)"}${
      extract ? `\n    page extract: ${extract}` : ""
    }`;
  }).join("\n");

  return `A user in ${country.toUpperCase()} (language: ${language}) is searching for: "${query}".
Below are ${pool.length} real web sources collected just now from a live search, with snippets and — for the most relevant ones — extracts of the pages themselves.

Write the thorough, specific answer a modern AI assistant would give this user, in ${language}.
- Ground EVERY factual claim in these sources and mark it with citation markers [n] matching the source numbers above.
- Prefer official sites and primary sources; compare concrete specifics (names, prices, options) that appear in the sources.
- NEVER invent a source, price, link, brand or number that is not in the material. If the sources do not cover something, say so instead of guessing.

SOURCES:
${sourceBlock}`;
}

/**
 * Citations from the answer, restricted to the collected pool.
 *
 * [n] markers are the primary contract. Markdown links and bare URLs are accepted too, but only
 * when they match a pool URL exactly (modulo trailing punctuation) — a URL that was never
 * collected by the search is a hallucination and must not become a citation. Order follows the
 * answer's first mention, so "in answer order" downstream stays true.
 */
export function citationsFromAnswer(
  answer: string,
  pool: OllamaSource[],
): { url: string; title: string; domain: string }[] {
  const byUrl = new Map(pool.map((s, i) => [s.url.replace(/\/+$/, ""), { ...s, n: i + 1 }]));
  const picked: { url: string; title: string; domain: string }[] = [];
  const seenN = new Set<number>();
  const addByUrl = (raw: string): boolean => {
    const url = raw.replace(/[),.;:!?\]]+$/, "").replace(/\/+$/, "");
    const hit = byUrl.get(url);
    if (!hit) return false;
    if (seenN.has(hit.n)) return true;
    seenN.add(hit.n);
    picked.push({ url: hit.url, title: hit.title, domain: hit.domain });
    return true;
  };

  // [n] markers, including adjacent forms like [1][3] and [1, 3].
  const nRe = /\[(\d{1,2})\]/g;
  let m: RegExpExecArray | null;
  while ((m = nRe.exec(answer))) {
    const n = Number(m[1]);
    const hit = pool[n - 1];
    if (!hit || seenN.has(n)) continue;
    seenN.add(n);
    picked.push({ url: hit.url, title: hit.title, domain: hit.domain });
  }
  // Markdown links and bare URLs — only pool members survive.
  const mdRe = /\[[^\]]{1,120}\]\((https?:\/\/[^\s)]+)\)/g;
  while ((m = mdRe.exec(answer))) addByUrl(m[1]);
  const bareRe = /https?:\/\/[^\s|)\]"'<>]+/g;
  while ((m = bareRe.exec(answer))) addByUrl(m[0]);

  return picked.slice(0, 60);
}

/**
 * Validation for the "ollama" engine, shared by the client gate and the API route.
 *
 * The OpenAI/kie/gemini engines need their vendor key because stage 1 is a provider-hosted
 * web_search call. The ollama engine's stage 1 is the app's own SERP integration (keyless
 * SearXNG, or the user's Serper key), and stage 2 runs on the user's configured AI provider —
 * so the vendor-key requirement disappears and the two things that DO have to exist are checked
 * instead: real stage-2 credentials, and a search source the server can actually reach.
 */
export function resolveGeoOllamaRun(p: {
  analysis?: { provider?: unknown; apiKey?: unknown; model?: unknown; baseUrl?: unknown };
  serp?: { provider?: unknown; key?: unknown; baseUrl?: unknown };
  searxngConfigured: boolean;
}): { ok: true; analysis: { provider: string; apiKey: string; model?: string; baseUrl?: string }; serp: { provider: "searxng" | "serper"; key: string; baseUrl?: string } }
  | { ok: false; error: string } {
  const a = (p.analysis && typeof p.analysis === "object") ? p.analysis : {};
  const provider = typeof a.provider === "string" ? a.provider.trim() : "";
  const apiKey = typeof a.apiKey === "string" ? a.apiKey.trim() : "";
  if (!provider || (!apiKey && provider !== "ollama-local")) {
    return { ok: false, error: "geo_no_analysis_creds" };
  }
  // Search source: SearXNG first (keyless, self-hosted); Serper only when the user sent a key.
  // Neither available → a clear refusal, never a fabricated answer from model weights.
  const serperKey = typeof p.serp?.key === "string" ? p.serp.key.trim() : "";
  if (!p.searxngConfigured && !serperKey) {
    return { ok: false, error: "geo_no_search_source" };
  }
  const useSerper = !p.searxngConfigured && !!serperKey;
  return {
    ok: true,
    analysis: {
      provider,
      apiKey,
      ...(typeof a.model === "string" && a.model.trim() ? { model: a.model.trim() } : {}),
      ...(typeof a.baseUrl === "string" && a.baseUrl.trim() ? { baseUrl: a.baseUrl.trim() } : {}),
    },
    serp: useSerper
      ? { provider: "serper", key: serperKey }
      : { provider: "searxng", key: "" },
  };
}
