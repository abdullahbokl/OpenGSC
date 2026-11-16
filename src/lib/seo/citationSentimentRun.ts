// Runs the sentiment analysis for a citations list: gather evidence, ask the model, fold it back.
//
// Split from `citationSentiment.ts` on purpose — that module stays pure and testable, this one
// touches the network (page fetches through scrape.ts, which falls back to the self-hosted
// Crawl4AI when a page blocks a plain fetch) and the AI provider.

import { fetchLLMDetailed } from "@/lib/llm";
import { scrapeMany } from "./scrape";
import type { Citation } from "./contentAnalysisShapes";
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
}

export interface CitationAnalysisResult {
  items: Citation[];
  sentimentAvailable: boolean;
  analyzed: number;
  unclear: number;
  unanalysed: number;
  scraped: number;
  provider: string;
  model: string;
  error?: string;
}

/**
 * Model used for this task when the caller names none.
 *
 * Measured on this deployment (2026-11-16, Arabic batch of 3): `mimo-v2.6-flash` answered in 1.3s
 * with correct positive/unclear/neutral verdicts, `gpt-oss:20b` in 3.2s, `minimax-m3.1-flash` in
 * 4.8s — while the account's default chat model (`deepseek-v4.1-flash:1017-cloud`, a reasoning
 * model) spent its entire token budget on hidden reasoning and returned no text at all. A short
 * JSON classification does not need a reasoning model; picking one per task is the existing
 * per-task-override convention, not a change to the global default.
 */
const OLLAMA_CITATION_MODEL = "mimo-v2.6-flash";

function resolveTaskModel(ai: CitationAiCreds): string {
  if ((ai.model || "").trim()) return String(ai.model).trim();
  const fromEnv = (process.env.CITATIONS_AI_MODEL || "").trim();
  if (fromEnv) return fromEnv;
  return ai.provider === "ollama" ? OLLAMA_CITATION_MODEL : "";
}

/** Snippet shorter than this gets a page fetch — a title alone is not evidence. */
const THIN_SNIPPET = 220;

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
 * The retry exists because the deployment's default Ollama model is a reasoning model: it can
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
  const model = resolveTaskModel(ai);
  const base = {
    items: citations,
    sentimentAvailable: false,
    analyzed: 0,
    unclear: 0,
    unanalysed: citations.length,
    scraped: 0,
    provider,
    model,
  };
  if (!ai.apiKey || !citations.length) return { ...base, error: ai.apiKey ? "no_items" : "no_ai_key" };

  const maxItems = Math.max(1, Math.min(citations.length, Number(opts.maxItems) || 24));
  const target = citations.slice(0, maxItems);
  const scrapeCount = Math.max(0, Math.min(target.length, opts.scrape ?? 8));
  const maxTokens = Math.max(400, Math.min(4096, Number(opts.maxTokens) || 1600));

  // Fetch full text only where the snippet cannot stand on its own. `scrapeMany` tries a direct
  // fetch first and falls back to Crawl4AI, so a JS-heavy or bot-protected page still yields text.
  const toFetch = scrapeCount > 0
    ? target
        .filter((item) => hasHttpUrl(item.url) && String(item.snippet || "").trim().length < THIN_SNIPPET)
        .slice(0, scrapeCount)
    : [];

  const pages = toFetch.length
    ? await scrapeMany(toFetch.map((item) => item.url), undefined, 3).catch(() => [])
    : [];
  const pageByUrl = new Map<string, string>();
  pages.forEach((page) => {
    if (page?.ok && page.textSample) pageByUrl.set(page.url, page.textSample);
  });

  const inputs: SentimentEvidenceInput[] = target.map((item) => ({
    url: item.url,
    title: item.title,
    snippet: item.snippet,
    pageText: pageByUrl.get(item.url),
  }));

  const batches: { start: number; items: SentimentEvidenceInput[] }[] = [];
  for (let start = 0; start < inputs.length; start += SENTIMENT_BATCH_SIZE) {
    batches.push({ start, items: inputs.slice(start, start + SENTIMENT_BATCH_SIZE) });
  }

  const merged = new Map<number, SentimentVerdict>();
  let firstError: string | undefined;
  const results = await mapWithConcurrency(batches, 2, async (batch) => {
    const { verdicts, error } = await classifyBatch(keyword, batch.items, ai, model, opts.lang, maxTokens);
    if (error && !firstError) firstError = error;
    return { start: batch.start, verdicts };
  });
  for (const { start, verdicts } of results) {
    for (const [offset, verdict] of verdicts) merged.set(start + offset, verdict);
  }

  const applied = applySentimentVerdicts(citations, merged, model ? `${provider}/${model}` : provider);
  return {
    items: applied.items,
    sentimentAvailable: applied.sentimentAvailable,
    analyzed: applied.classified,
    unclear: applied.unclear,
    unanalysed: applied.unanalysed,
    scraped: pageByUrl.size,
    provider,
    model,
    error: applied.sentimentAvailable ? undefined : (firstError ?? "no_verdicts"),
  };
}

/** Guards the fetch list against rows without a usable URL (search engines occasionally emit ""). */
function hasHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(String(url || ""));
}
