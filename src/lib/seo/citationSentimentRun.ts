// Runs the sentiment analysis for a citations list: gather evidence, ask the model, fold it back.
//
// Split from `citationSentiment.ts` on purpose — that module stays pure and testable, this one
// touches the network (page fetches through scrape.ts, which falls back to the self-hosted
// Crawl4AI when a page blocks a plain fetch) and the AI provider.

import { fetchLLMDetailed } from "@/lib/llm";
import { scrapeMany } from "@/lib/seo/scrape";
import type { Citation } from "./contentAnalysisShapes";
import { taskModelFor } from "./taskModels";
import {
  applySentimentVerdicts,
  buildCitationSentimentPrompt,
  parseSentimentVerdicts,
  SENTIMENT_BATCH_SIZE,
  type SentimentEvidenceInput,
  type SentimentVerdict,
} from "./citationSentiment";

export interface CitationAiCreds {
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export interface CitationAnalysisOptions {
  /** Language hint for the evidence quotes — the page's own language is still preserved. */
  lang?: string;
  /** How many top mentions to fetch full text for. 0 disables fetching (snippets only). */
  scrape?: number;
  /** How many mentions to classify. Rows past this stay unanalysed. */
  maxItems?: number;
  maxTokens?: number;
  /** Concurrent model calls. Default 3; the provider's rate limit is the real ceiling. */
  concurrency?: number;
  /** Called after each finished batch, so a long job can report progress. */
  onProgress?: (done: number, total: number) => void;
}

export interface CitationAnalysisResult {
  items: Citation[];
  sentimentAvailable: boolean;
  /** Rows with a positive/neutral/negative verdict and a quote. */
  analyzed: number;
  /** Rows the model read and could not judge. */
  unclear: number;
  /** Rows never sent to the model (over the limit). */
  unanalysed: number;
  /** Rows whose page text could not be fetched (judged on snippet/title). */
  failedExtraction: number;
  scraped: number;
  /** Verdicts reused from an earlier run in this process instead of re-asked. */
  cached: number;
  provider: string;
  model: string;
  error?: string;
}

/** Snippet shorter than this gets a page fetch — a title alone is not evidence. */
const THIN_SNIPPET = 220;
/** Default ceiling on mentions analysed per run. Overridable per request, hard-capped below. */
const DEFAULT_MAX_ITEMS = 48;
const HARD_MAX_ITEMS = 150;
/** Verdict cache TTL: long enough to make a re-run cheap, short enough to see fresh coverage. */
const CACHE_TTL_MS = 30 * 60 * 1000;

const verdictCache = new Map<string, { verdict: SentimentVerdict; at: number }>();

function cacheKey(model: string, keyword: string, url: string): string {
  return `${model}|${keyword.trim().toLowerCase()}|${url}`;
}

/** Drop expired entries so a long-running server does not accumulate them forever. */
function pruneCache(now: number): void {
  for (const [key, entry] of verdictCache) if (now - entry.at > CACHE_TTL_MS) verdictCache.delete(key);
}

function hasHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(String(url || ""));
}

/** Video pages expose no body text to a scraper; their description is all a reader gets. */
function isVideoHost(url: string): boolean {
  return /(^|\.)(youtube\.com|youtu\.be)$/i.test(hostOf(url));
}
function isForumHost(url: string): boolean {
  return /(^|\.)(reddit\.com|redd\.it)$/i.test(hostOf(url));
}
function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return ""; }
}

/**
 * Public oEmbed metadata for a video URL: title + channel, no key, no scraping.
 *
 * YouTube is the one source where the page body is unreachable and the snippet is usually empty, so
 * without this a video row would be classified from its URL alone. oEmbed is the publisher's own
 * documented endpoint; when it does not answer, the row falls back to its search snippet and is
 * labelled as such rather than guessed at.
 */
async function videoMeta(url: string): Promise<string> {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { title?: string; author_name?: string };
    return [data.title, data.author_name].filter(Boolean).join(" — ").slice(0, 400);
  } catch {
    return "";
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  fn: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, values.length)) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(values[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Classify one batch, retrying once with a larger budget when the model returned nothing usable.
 *
 * The retry exists because a deployment's default Ollama model can be a reasoning model: it can
 * spend the whole `max_tokens` on hidden reasoning and emit no JSON at all. One retry with room
 * to think is cheaper than reporting a false "sentiment unavailable".
 */
async function classifyBatch(
  keyword: string,
  batch: SentimentEvidenceInput[],
  ai: CitationAiCreds,
  model: string,
  lang: string | undefined,
  maxTokens: number,
): Promise<{ verdicts: Map<number, SentimentVerdict>; error?: string }> {
  const prompt = buildCitationSentimentPrompt(keyword, batch, lang);
  let lastError: string | undefined;
  for (const budget of [maxTokens, Math.round(maxTokens * 1.75)]) {
    const { text, error } = await fetchLLMDetailed(
      prompt,
      ai.provider,
      ai.apiKey,
      budget,
      model || undefined,
      ai.baseUrl || undefined,
      0,
    );
    if (text) {
      const verdicts = parseSentimentVerdicts(text, batch.length);
      if (verdicts.size > 0) return { verdicts };
      lastError = "unparseable_reply";
      continue;
    }
    lastError = error ?? "empty_reply";
  }
  return { verdicts: new Map(), error: lastError };
}

/**
 * Analyse citations with the configured chat model.
 *
 * Returns the same list with polarity/emotions/confidence/evidence filled where the model could
 * judge, `unclear` where it could not, and untouched where no call succeeded. It never fabricates
 * a verdict: a total failure reports `sentimentAvailable: false` and the error.
 */
export async function analyzeCitationSentiment(
  citations: Citation[],
  keyword: string,
  ai: CitationAiCreds,
  opts: CitationAnalysisOptions = {},
): Promise<CitationAnalysisResult> {
  const provider = ai.provider;
  const model = (ai.model || "").trim() || taskModelFor(provider, "citations");
  const base = {
    items: citations,
    sentimentAvailable: false,
    analyzed: 0,
    unclear: 0,
    unanalysed: citations.length,
    failedExtraction: 0,
    scraped: 0,
    cached: 0,
    provider,
    model,
  };
  if (!ai.apiKey || !citations.length) return { ...base, error: ai.apiKey ? "no_items" : "no_ai_key" };

  const maxItems = Math.max(1, Math.min(HARD_MAX_ITEMS, Number(opts.maxItems) || DEFAULT_MAX_ITEMS));
  // Dedupe before anything else: the same URL surfacing twice must cost one fetch and one verdict,
  // and the second row inherits the first one's result.
  const target = citations.slice(0, maxItems);
  const uniqueUrls: string[] = [];
  const firstIndexByUrl = new Map<string, number>();
  target.forEach((item, index) => {
    if (!hasHttpUrl(item.url)) return;
    if (!firstIndexByUrl.has(item.url)) { firstIndexByUrl.set(item.url, index); uniqueUrls.push(item.url); }
  });

  const scrapeCount = Math.max(0, Math.min(uniqueUrls.length, opts.scrape ?? 10));
  const maxTokens = Math.max(400, Math.min(4096, Number(opts.maxTokens) || 1600));
  const concurrency = Math.max(1, Math.min(4, Number(opts.concurrency) || 3));

  // Fetch full text only where the snippet cannot stand on its own. `scrapeMany` tries a direct
  // fetch first and falls back to Crawl4AI, so a JS-heavy or bot-protected page still yields text.
  const thinUrls = uniqueUrls.filter((url) => {
    const index = firstIndexByUrl.get(url) ?? -1;
    const item = index >= 0 ? target[index] : undefined;
    if (!item) return false;
    if (isVideoHost(url)) return true;
    return String(item.snippet || "").trim().length < THIN_SNIPPET;
  }).slice(0, scrapeCount);

  const [pages, videoTexts] = await Promise.all([
    thinUrls.length
      ? scrapeMany(thinUrls, undefined, 3).catch(() => [])
      : Promise.resolve([]),
    Promise.all(thinUrls.filter(isVideoHost).map(async (url) => [url, await videoMeta(url)] as const)),
  ]);

  const pageByUrl = new Map<string, string>();
  pages.forEach((page) => {
    if (page?.ok && page.textSample) pageByUrl.set(page.url, page.textSample);
  });
  for (const [url, text] of videoTexts) {
    if (text && !pageByUrl.has(url)) pageByUrl.set(url, text);
  }

  const inputs: SentimentEvidenceInput[] = target.map((item) => {
    const page = pageByUrl.get(item.url);
    const source: SentimentEvidenceInput["source"] = page
      ? (isVideoHost(item.url) ? "title" : "page")
      : (String(item.snippet || "").trim() ? "snippet" : "title");
    return {
      url: item.url,
      title: item.title,
      snippet: item.snippet,
      pageText: page,
      source,
    };
  });

  // Verdicts from an earlier run of the same keyword on the same model are reused as-is: a re-run
  // after a partial failure must not re-pay for rows that already have an answer.
  const now = Date.now();
  pruneCache(now);
  const merged = new Map<number, SentimentVerdict>();
  let cached = 0;
  const pending: { index: number; input: SentimentEvidenceInput }[] = [];
  inputs.forEach((input, index) => {
    const hit = verdictCache.get(cacheKey(model, keyword, input.url));
    if (hit) { merged.set(index, hit.verdict); cached += 1; return; }
    pending.push({ index, input });
  });

  const batches: { start: number; items: SentimentEvidenceInput[]; indexes: number[] }[] = [];
  for (let start = 0; start < pending.length; start += SENTIMENT_BATCH_SIZE) {
    const slice = pending.slice(start, start + SENTIMENT_BATCH_SIZE);
    batches.push({ start, items: slice.map((p) => p.input), indexes: slice.map((p) => p.index) });
  }

  let firstError: string | undefined;
  let done = cached;
  const results = await mapWithConcurrency(batches, concurrency, async (batch) => {
    const { verdicts, error } = await classifyBatch(keyword, batch.items, ai, model, opts.lang, maxTokens);
    if (error && !firstError) firstError = error;
    done += batch.items.length;
    opts.onProgress?.(done, inputs.length);
    return { batch, verdicts };
  });
  for (const { batch, verdicts } of results) {
    for (const [offset, verdict] of verdicts) {
      const index = batch.indexes[offset];
      if (index === undefined) continue;
      merged.set(index, verdict);
      verdictCache.set(cacheKey(model, keyword, inputs[index].url), { verdict, at: Date.now() });
    }
  }

  // A row analysed from its title alone must say so — the verdict is real, its basis is thinner.
  const labelled = target.map((item, index) => {
    const source = inputs[index]?.source;
    if (!source || source === "page") return item;
    return { ...item, evidenceSource: source };
  });

  const applied = applySentimentVerdicts(labelled, merged, model ? `${provider}/${model}` : provider);
  // Counted against what was actually ATTEMPTED: a snippet-only row was never a failed fetch, while
  // a page we asked for and did not get is exactly the number an operator needs to see.
  const failedExtraction = thinUrls.filter((url) => !pageByUrl.has(url)).length;
  return {
    items: applied.items,
    sentimentAvailable: applied.sentimentAvailable,
    analyzed: applied.classified,
    unclear: applied.unclear,
    unanalysed: applied.unanalysed,
    failedExtraction,
    scraped: pageByUrl.size,
    cached,
    provider,
    model,
    error: applied.sentimentAvailable ? undefined : (firstError ?? "no_verdicts"),
  };
}

/** Number of mentions a single run will analyse when the caller does not say. */
export const CITATION_MAX_ITEMS_DEFAULT = DEFAULT_MAX_ITEMS;
export const CITATION_MAX_ITEMS_CAP = HARD_MAX_ITEMS;
