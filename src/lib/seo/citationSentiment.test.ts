import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySentimentVerdicts,
  buildCitationSentimentPrompt,
  parseSentimentVerdicts,
  SENTIMENT_BATCH_SIZE,
} from "./citationSentiment";
import type { Citation } from "./contentAnalysisShapes";

function citation(url: string, title = "title", snippet = "snippet"): Citation {
  return {
    url,
    domain: new URL(url).hostname,
    title,
    snippet,
    polarity: "unknown",
    emotions: { anger: 0, happiness: 0, love: 0, sadness: 0, share: 0, fun: 0 },
    date: "",
    score: 0,
    sentimentAvailable: false,
    source: "searxng",
  };
}

test("the prompt carries every item, the brand and the neutral-vs-unclear rule", () => {
  const prompt = buildCitationSentimentPrompt(
    "أرامكو",
    [
      { url: "https://example.com/a", title: "مراجعة", snippet: "نص عربي", pageText: "مقالة كاملة عن الشركة" },
      { url: "https://example.com/b", title: "Login", snippet: "" },
    ],
    "ar",
  );

  assert.match(prompt, /"أرامكو"/);
  assert.match(prompt, /### 1\nURL: https:\/\/example\.com\/a/);
  assert.match(prompt, /### 2\nURL: https:\/\/example\.com\/b/);
  assert.match(prompt, /ARTICLE_BODY_MARKER|مقالة كاملة عن الشركة/);
  assert.match(prompt, /\(no text available\)/);
  assert.match(prompt, /Use "neutral" ONLY when the text discusses the subject/);
  assert.match(prompt, /Reply with JSON only/);
  assert.match(prompt, /preferred: ar/);
});

test("verdicts parse from fenced JSON with prose around it", () => {
  const raw = [
    "Sure, here is the analysis:",
    "```json",
    JSON.stringify({
      results: [
        { i: 1, sentiment: "positive", confidence: 0.82, brand_mentioned: true, emotions: { happiness: 44 }, evidence: "أفضل منتج" },
        { i: 2, sentiment: "negative", confidence: 0.7, brand_mentioned: true, emotions: { anger: 61 }, evidence: "سيء جداً" },
      ],
    }),
    "```",
    "Hope that helps.",
  ].join("\n");

  const verdicts = parseSentimentVerdicts(raw, 2);
  assert.equal(verdicts.size, 2);
  assert.deepEqual(verdicts.get(0), {
    sentiment: "positive",
    confidence: 0.82,
    emotions: { happiness: 44 },
    evidence: "أفضل منتج",
    brandMentioned: true,
  });
  assert.equal(verdicts.get(1)?.sentiment, "negative");
  assert.equal(verdicts.get(1)?.emotions.anger, 61);
});

test("a 0-1 confidence scale and bare-array replies are accepted", () => {
  const raw = JSON.stringify([
    { index: 1, label: "neutral", confidence: 82, emotions: { fun: 0.4 }, evidence: "الشركة تأسست عام ١٩٩٠" },
  ]);
  const verdicts = parseSentimentVerdicts(raw, 1);
  assert.equal(verdicts.get(0)?.confidence, 0.82);
  assert.equal(verdicts.get(0)?.sentiment, "neutral");
  assert.equal(verdicts.get(0)?.emotions.fun, 40);
});

test("rows without evidence stay unclear and never become neutral", () => {
  const raw = JSON.stringify({
    results: [
      { i: 1, sentiment: "neutral", confidence: 0.9, evidence: "", brand_mentioned: false },
      { i: 2, sentiment: "neutral", confidence: 0.8, evidence: "التقرير يذكر الشركة في جدول", brand_mentioned: true },
      { i: 3, sentiment: "mixed", confidence: 0.4 },
    ],
  });
  const verdicts = parseSentimentVerdicts(raw, 3);
  // "neutral" with no quote is an unsupported claim — downgraded, not published.
  assert.equal(verdicts.get(0)?.sentiment, "unclear");
  assert.equal(verdicts.get(0)?.emotions.happiness, undefined);
  // A factual mention with a quote is a real neutral finding.
  assert.equal(verdicts.get(1)?.sentiment, "neutral");
  // An unmodelled label degrades to unclear instead of being coerced to neutral.
  assert.equal(verdicts.get(2)?.sentiment, "unclear");
  assert.equal(verdicts.get(2)?.evidence, "");
});

test("out-of-range and duplicate indices are rejected, and unparseable text yields nothing", () => {
  assert.equal(parseSentimentVerdicts(JSON.stringify({ results: [{ i: 9, sentiment: "positive" }] }), 2).size, 0);
  assert.equal(parseSentimentVerdicts("no json here at all", 3).size, 0);
  assert.equal(parseSentimentVerdicts(null, 3).size, 0);
  const dupes = parseSentimentVerdicts(
    JSON.stringify({ results: [{ i: 1, sentiment: "positive", confidence: 0.9, evidence: "ممتاز" }, { i: 1, sentiment: "negative" }] }),
    2,
  );
  assert.equal(dupes.size, 1);
  assert.equal(dupes.get(0)?.sentiment, "positive");
});

test("applying verdicts fills polarity, emotions and evidence — unclear becomes unknown", () => {
  const items = [citation("https://a.example/1"), citation("https://b.example/2"), citation("https://c.example/3")];
  const verdicts = parseSentimentVerdicts(
    JSON.stringify({
      results: [
        { i: 1, sentiment: "positive", confidence: 0.8, brand_mentioned: true, emotions: { love: 70, happiness: 20 }, evidence: "great" },
        { i: 2, sentiment: "unclear", confidence: 0.2, brand_mentioned: false },
      ],
    }),
    3,
  );

  const applied = applySentimentVerdicts(items, verdicts, "ollama/model");

  assert.equal(applied.classified, 1);
  assert.equal(applied.unclear, 1);
  assert.equal(applied.unanalysed, 1);
  assert.equal(applied.sentimentAvailable, true);

  assert.equal(applied.items[0].polarity, "positive");
  assert.equal(applied.items[0].topEmotion, "love");
  assert.equal(applied.items[0].confidence, 0.8);
  assert.equal(applied.items[0].evidence, "great");
  assert.equal(applied.items[0].analyzedBy, "ollama/model");

  assert.equal(applied.items[1].polarity, "unknown");
  assert.equal(applied.items[1].emotions.love, 0);
  assert.equal(applied.items[1].topEmotion, undefined);
  assert.equal(applied.items[1].sentimentAvailable, true);

  // Untouched row keeps its original "no sentiment" state.
  assert.equal(applied.items[2].sentimentAvailable, false);
});

test("all-unclear means sentiment is not available", () => {
  const items = [citation("https://a.example/1"), citation("https://b.example/2")];
  const verdicts = parseSentimentVerdicts(
    JSON.stringify({ results: [{ i: 1, sentiment: "unclear" }, { i: 2, sentiment: "unclear" }] }),
    2,
  );
  const applied = applySentimentVerdicts(items, verdicts);
  assert.equal(applied.sentimentAvailable, false);
  assert.equal(applied.unclear, 2);
});

test("the batch size stays small enough for a reasoning model to answer in one pass", () => {
  assert.ok(SENTIMENT_BATCH_SIZE >= 4 && SENTIMENT_BATCH_SIZE <= 10);
});
