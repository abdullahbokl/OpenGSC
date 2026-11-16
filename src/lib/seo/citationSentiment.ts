// Sentiment + emotion for brand citations, from an LLM instead of DataForSEO.
//
// DataForSEO's Content Analysis endpoint returns connotation counters next to each mention, which
// is why the citations feature used to require a DataForSEO key. The mentions themselves come from
// a web search — SearXNG supplies those for free — so the only thing genuinely missing was a
// reading of each page. That reading is what this module asks a chat model for, one batch at a time.
//
// The hard rule: a page that does not actually discuss the brand is NOT "neutral". Neutral is a
// finding (the text talks about the subject factually); no finding at all is `unclear`, which the
// UI shows as unknown. Filling those rows with "neutral" is how a sentiment chart becomes fiction.
//
// Pure by design — no network, no Prisma — so the prompt and the parser are unit-tested directly.

import { EMOTIONS, type Citation, type Emotion } from "./contentAnalysisShapes";

export type VerdictSentiment = "positive" | "neutral" | "negative" | "unclear";

/** What the model is asked to read for one mention. */
export interface SentimentEvidenceInput {
  url: string;
  title: string;
  snippet: string;
  /** Article body when the snippet alone is too thin to judge. */
  pageText?: string;
}

export interface SentimentVerdict {
  sentiment: VerdictSentiment;
  /** 0–1, the model's own confidence in the verdict. */
  confidence: number;
  /** 0–100 per emotion; 0 when the text gives no basis for that emotion. */
  emotions: Partial<Record<Emotion, number>>;
  /** Verbatim fragment from the supplied text that supports the verdict, "" when unclear. */
  evidence: string;
  brandMentioned: boolean;
}

/** Items per model call. Small batches keep one bad response from sinking a whole page of rows. */
export const SENTIMENT_BATCH_SIZE = 6;

/** Cap on the text handed to the model per item — a snippet plus the article opening is enough. */
const MAX_EVIDENCE_CHARS = 1600;

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

function trimEvidence(text: string | undefined): string {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_EVIDENCE_CHARS);
}

/**
 * The prompt. Numbered items, an explicit JSON schema, and the neutral-vs-unclear distinction
 * spelled out — a model that is told "when in doubt say neutral" produces a flat, useless chart.
 */
export function buildCitationSentimentPrompt(
  keyword: string,
  items: SentimentEvidenceInput[],
  lang?: string,
): string {
  const language = (lang || "").trim();
  const blocks = items.map((item, index) => {
    const body = trimEvidence(item.pageText) || trimEvidence(item.snippet);
    return [
      `### ${index + 1}`,
      `URL: ${item.url}`,
      `TITLE: ${trimEvidence(item.title).slice(0, 300)}`,
      `TEXT: ${body || "(no text available)"}`,
    ].join("\n");
  });

  return [
    `You are classifying how web pages talk about "${keyword}".`,
    language
      ? `Write the evidence quote in the page's own language (preferred: ${language}); never translate it.`
      : "Write the evidence quote in the page's own language; never translate it.",
    "",
    "For EVERY numbered item return one object with:",
    '- "i": the item number (1-based, integer)',
    '- "sentiment": "positive" | "neutral" | "negative" | "unclear"',
    '- "confidence": number from 0 to 1',
    '- "brand_mentioned": true when the text actually discusses the subject, otherwise false',
    '- "emotions": object with any of anger, happiness, love, sadness, share, fun — integers 0-100',
    '  (0 for every emotion the text does not support; never invent intensity)',
    '- "evidence": a verbatim fragment (max 25 words) copied from TEXT that supports the verdict,',
    '  or "" when the verdict is unclear',
    "",
    "Rules:",
    `- Sentiment is about how the text treats "${keyword}", not about the page's overall mood.`,
    "- Use \"neutral\" ONLY when the text discusses the subject in a factual, non-evaluative way.",
    "- Use \"unclear\" when the text does not discuss the subject, is navigation/a list of links,",
    "  is a login wall or a cookie notice, or carries no evidence for any polarity.",
    "- Never guess: an unreadable page is \"unclear\" with confidence 0.",
    "- Reply with JSON only, no prose, no code fence:",
    '{"results":[{"i":1,"sentiment":"positive","confidence":0.8,"brand_mentioned":true,"emotions":{"happiness":40},"evidence":"..."}]}',
    "",
    "Items:",
    blocks.join("\n\n"),
  ].join("\n");
}

/** Pull the first JSON object/array out of a model reply, tolerating prose or a code fence. */
function extractPayload(raw: string): unknown {
  const text = String(raw ?? "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  // A bare array wins only when it starts before any object.
  const useArray = arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart);
  const start = useArray ? arrayStart : objectStart;
  if (start === -1) return null;
  const end = useArray ? text.lastIndexOf("]") : text.lastIndexOf("}");
  if (end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function pickRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["results", "items", "data", "mentions"]) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
}

function normalizeSentiment(value: unknown): VerdictSentiment {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "positive" || s === "neutral" || s === "negative" || s === "unclear") return s;
  // Common near-misses a model still produces. Anything else is honestly unclear.
  if (s === "pos" || s === "favorable" || s === "favourable") return "positive";
  if (s === "neg" || s === "unfavorable" || s === "unfavourable") return "negative";
  if (s === "mixed" || s === "unknown" || s === "none" || s === "") return "unclear";
  return "unclear";
}

function normalizeEmotions(value: unknown): Partial<Record<Emotion, number>> {
  const out: Partial<Record<Emotion, number>> = {};
  if (!value || typeof value !== "object") return out;
  const record = value as Record<string, unknown>;
  for (const emotion of EMOTIONS) {
    const raw = Number(record[emotion]);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    // Accept the 0-1 scale a model sometimes uses even when told 0-100.
    out[emotion] = Math.round(raw <= 1 ? raw * 100 : clamp(raw, 0, 100));
  }
  return out;
}

/**
 * Parse a model reply into verdicts keyed by 0-based item index.
 *
 * Anything unusable is dropped rather than invented — the caller then reports those rows as
 * unanalysed. `total` is the number of items the prompt contained, so an out-of-range index is
 * rejected instead of silently landing on the wrong row.
 */
export function parseSentimentVerdicts(raw: string | null, total: number): Map<number, SentimentVerdict> {
  const verdicts = new Map<number, SentimentVerdict>();
  if (!raw || total <= 0) return verdicts;
  const rows = pickRows(extractPayload(raw));
  rows.forEach((row, position) => {
    if (!row || typeof row !== "object") return;
    const record = row as Record<string, unknown>;
    const rawIndex = Number(record.i ?? record.index ?? record.id ?? position + 1);
    // `i` is documented as 1-based; a 0 is treated as 1-based overflow rather than crashing out.
    const index = Number.isInteger(rawIndex) ? (rawIndex >= 1 ? rawIndex - 1 : rawIndex) : -1;
    if (index < 0 || index >= total || verdicts.has(index)) return;
    const sentiment = normalizeSentiment(record.sentiment ?? record.label ?? record.polarity);
    const confidenceRaw = Number(record.confidence ?? record.score ?? 0);
    const confidence = clamp(confidenceRaw > 1 ? confidenceRaw / 100 : confidenceRaw, 0, 1);
    const brandRaw = record.brand_mentioned ?? record.brandMentioned ?? record.mentions_brand;
    const evidence = trimEvidence(String(record.evidence ?? record.quote ?? "")).slice(0, 300);
    // A verdict with no quote behind it is not a verdict. Downgrading here rather than trusting
    // the label is what keeps "we could not read this page" out of the neutral column.
    const finalSentiment: VerdictSentiment = sentiment !== "unclear" && !evidence ? "unclear" : sentiment;
    verdicts.set(index, {
      sentiment: finalSentiment,
      confidence: finalSentiment === "unclear" ? confidence : confidence || 0.5,
      emotions: finalSentiment === "unclear" ? {} : normalizeEmotions(record.emotions),
      evidence: finalSentiment === "unclear" ? "" : evidence,
      brandMentioned: brandRaw === true || String(brandRaw ?? "").toLowerCase() === "true",
    });
  });
  return verdicts;
}

export interface ApplySentimentResult {
  items: Citation[];
  /** Rows that received a positive/neutral/negative verdict with evidence. */
  classified: number;
  /** Rows the model explicitly could not judge. */
  unclear: number;
  /** Rows with no verdict at all (batch failed, item skipped). */
  unanalysed: number;
  /** True when at least one row carries a real, evidence-backed verdict. */
  sentimentAvailable: boolean;
}

/**
 * Fold verdicts into citations.
 *
 * `unclear` becomes polarity "unknown" with zeroed emotions — never "neutral". A row without any
 * verdict keeps whatever it had and counts as unanalysed, so the UI can say how much of the list
 * the model actually read instead of implying blanket coverage.
 */
export function applySentimentVerdicts(
  items: Citation[],
  verdicts: Map<number, SentimentVerdict>,
  analyzedBy?: string,
): ApplySentimentResult {
  const zeroEmotions = Object.fromEntries(EMOTIONS.map((emotion) => [emotion, 0])) as Record<Emotion, number>;
  let classified = 0;
  let unclear = 0;
  let unanalysed = 0;

  const out = items.map((item, index) => {
    const verdict = verdicts.get(index);
    if (!verdict) {
      unanalysed += 1;
      return item;
    }
    if (verdict.sentiment === "unclear") {
      unclear += 1;
      return {
        ...item,
        polarity: "unknown" as const,
        emotions: { ...zeroEmotions },
        topEmotion: undefined,
        confidence: verdict.confidence,
        evidence: "",
        brandMentioned: verdict.brandMentioned,
        sentimentAvailable: true,
        analyzedBy,
      };
    }
    classified += 1;
    const emotions = { ...zeroEmotions, ...verdict.emotions };
    let topEmotion: Emotion | undefined;
    let topValue = 0;
    for (const emotion of EMOTIONS) {
      const value = emotions[emotion];
      if (value > topValue) { topValue = value; topEmotion = emotion; }
    }
    return {
      ...item,
      polarity: verdict.sentiment,
      emotions,
      topEmotion,
      confidence: verdict.confidence,
      evidence: verdict.evidence,
      brandMentioned: verdict.brandMentioned,
      sentimentAvailable: true,
      analyzedBy,
    };
  });

  return { items: out, classified, unclear, unanalysed, sentimentAvailable: classified > 0 };
}
