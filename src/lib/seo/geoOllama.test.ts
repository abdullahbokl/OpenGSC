import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOllamaAnswerPrompt,
  citationsFromAnswer,
  resolveGeoOllamaRun,
  type OllamaSource,
} from "./geoOllama";

const pool: OllamaSource[] = [
  { url: "https://example-a.com/page", title: "Provider A", domain: "example-a.com", snippet: "prices from 100" },
  { url: "https://example-b.org/guide", title: "Guide B", domain: "example-b.org", snippet: "how to choose" },
  { url: "https://example-c.com/", title: "Store C", domain: "example-c.com", snippet: "official store" },
];

test("citationsFromAnswer keeps only pool sources, in answer order", () => {
  const answer = "The best option is [2] first, then [1] for price. See [3] and the store at https://example-c.com/ too. Invented: [9] and https://not-in-pool.example/x should vanish.";
  const cites = citationsFromAnswer(answer, pool);
  assert.deepEqual(cites.map(c => c.domain), ["example-b.org", "example-a.com", "example-c.com"]);
  assert.equal(cites.length, 3); // [9] out of range, foreign URL dropped
});

test("citationsFromAnswer returns nothing for an uncited answer", () => {
  assert.equal(citationsFromAnswer("A generic answer with no references at all.", pool).length, 0);
});

test("buildOllamaAnswerPrompt embeds the numbered pool and page extracts", () => {
  const texts = new Map([["https://example-a.com/page", "PRICES FROM 100 EGP ..."]]);
  const prompt = buildOllamaAnswerPrompt("هل دوال الخصية تزول", "ar", "eg", pool, texts);
  assert.ok(prompt.includes('هل دوال الخصية تزول'));
  assert.ok(prompt.includes("[1] example-a.com — Provider A"));
  assert.ok(prompt.includes("page extract: PRICES FROM 100 EGP"));
  assert.ok(prompt.includes("in ar")); // language directive present
  assert.ok(prompt.includes("NEVER invent"));
});

test("resolveGeoOllamaRun validates creds and picks the search source", () => {
  // No analysis creds → explicit refusal, no run.
  assert.equal(resolveGeoOllamaRun({ searxngConfigured: true }).ok, false);
  assert.equal((resolveGeoOllamaRun({ searxngConfigured: true }) as { error: string }).error, "geo_no_analysis_creds");

  // Ollama key present + SearXNG configured → searxng, no Serper key needed.
  const ok = resolveGeoOllamaRun({
    analysis: { provider: "ollama", apiKey: "k", model: "deepseek-v4.1-flash:1017" },
    serp: { provider: "serper", key: "" },
    searxngConfigured: true,
  });
  assert.equal(ok.ok, true);
  assert.equal((ok as { serp: { provider: string } }).serp.provider, "searxng");
  assert.equal((ok as { analysis: { model?: string } }).analysis.model, "deepseek-v4.1-flash:1017");

  // SearXNG absent + Serper key present → serper; absent + no key → honest refusal.
  const serper = resolveGeoOllamaRun({
    analysis: { provider: "ollama", apiKey: "k" },
    serp: { provider: "serper", key: "sk" },
    searxngConfigured: false,
  });
  assert.equal((serper as { serp: { provider: string } }).serp.provider, "serper");
  const none = resolveGeoOllamaRun({
    analysis: { provider: "ollama", apiKey: "k" },
    serp: { provider: "serper", key: "" },
    searxngConfigured: false,
  });
  assert.equal((none as { error: string }).error, "geo_no_search_source");
});
