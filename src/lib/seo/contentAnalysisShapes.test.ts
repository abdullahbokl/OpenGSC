import { test } from "node:test";
import assert from "node:assert/strict";
import { citationsFromMentions, EMOTIONS } from "./contentAnalysisShapes";

test("SearXNG citations keep mentions but never fabricate sentiment", () => {
  const citations = citationsFromMentions([
    {
      url: "https://example.com/article",
      title: "مراجعة العلامة التجارية",
      snippet: "نص عربي عن العلامة",
      domain: "example.com",
      score: 4.2,
    },
    { url: "", title: "ignored" },
  ]);

  assert.equal(citations.length, 1);
  assert.equal(citations[0].url, "https://example.com/article");
  assert.equal(citations[0].title, "مراجعة العلامة التجارية");
  assert.equal(citations[0].domain, "example.com");
  assert.equal(citations[0].polarity, "unknown");
  assert.equal(citations[0].sentimentAvailable, false);
  assert.equal(citations[0].source, "searxng");
  assert.equal(citations[0].score, 4.2);
  for (const emotion of EMOTIONS) assert.equal(citations[0].emotions[emotion], 0);
});

test("a mention without a title or snippet still has a usable URL/title", () => {
  const [citation] = citationsFromMentions([{ url: "https://brand.example/" }]);
  assert.equal(citation.title, "https://brand.example/");
  assert.equal(citation.snippet, "");
  assert.equal(citation.domain, "");
});
