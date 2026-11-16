import { test } from "node:test";
import assert from "node:assert/strict";
import {
  domainMatches,
  seedQueriesFromGsc,
  aggregateCompetitorsFromSerp,
  competitorRowsFromQueries,
  extractKeywordCandidates,
  type SeededSerp,
} from "./gapFree";

test("domainMatches treats www and subdomains as the same registrable domain", () => {
  assert.equal(domainMatches("example.com", "example.com"), true);
  assert.equal(domainMatches("www.example.com", "example.com"), true);
  assert.equal(domainMatches("blog.example.com", "example.com"), true);
  assert.equal(domainMatches("notexample.com", "example.com"), false);
  assert.equal(domainMatches("example.org", "example.com"), false);
  assert.equal(domainMatches("", "example.com"), false);
});

test("seedQueriesFromGsc ranks by impressions, dedupes and drops brand queries", () => {
  const rows = [
    { query: "ketotifen dose", impressions: 900 },
    { query: "Ketotifen Dose", impressions: 400 }, // same query, different case
    { query: "ketotifen.com reviews", impressions: 5000 }, // brand-ish — dropped
    { query: "best eye drops for allergies", impressions: 120 },
    { query: "  ", impressions: 50 },
    { query: "fexofenadine vs ketotifen", impressions: 60 },
  ];
  const seeds = seedQueriesFromGsc(rows, "ketotifen.com", 8);
  assert.deepEqual(seeds, ["ketotifen dose", "best eye drops for allergies", "fexofenadine vs ketotifen"]);
  // max is honoured
  assert.deepEqual(seedQueriesFromGsc(rows, "ketotifen.com", 1), ["ketotifen dose"]);
});

test("aggregateCompetitorsFromSerp counts per-domain coverage and excludes the target", () => {
  const row = (pos: number, domain: string, url?: string) => ({
    position: pos, url: url ?? `https://${domain}/p`, title: "", domain,
  });
  const seeded: SeededSerp[] = [
    { query: "a", rows: [row(1, "rival.com"), row(2, "target.com"), row(3, "news.io")] },
    { query: "b", rows: [row(1, "rival.com"), row(4, "other.org"), row(2, "www.target.com")] },
    { query: "c", rows: [row(1, "news.io")] },
  ];
  const found = aggregateCompetitorsFromSerp(seeded, "target.com");
  // Coverage order, ties broken alphabetically; the target (and its www form) is gone.
  assert.deepEqual(found, [
    { domain: "news.io", sharedKeywords: 2 },
    { domain: "rival.com", sharedKeywords: 2 },
    { domain: "other.org", sharedKeywords: 1 },
  ]);
});

test("competitorRowsFromQueries keeps the best position per query and respects maxPosition", () => {
  const row = (pos: number, domain: string, url?: string) => ({
    position: pos, url: url ?? `https://${domain}/p`, title: "", domain,
  });
  const seeded: SeededSerp[] = [
    { query: "alpha", rows: [row(7, "rival.com", "https://rival.com/a"), row(3, "rival.com", "https://rival.com/b")] },
    { query: "beta", rows: [row(1, "rival.com")] },
    { query: "gamma", rows: [row(31, "rival.com"), row(2, "other.org")] }, // beyond top 20 → absent
  ];
  const rows = competitorRowsFromQueries(seeded, "rival.com", 20);
  // Sorted by observed position, best first.
  assert.deepEqual(rows, [
    { keyword: "beta", position: 1, url: "https://rival.com/p" },
    { keyword: "alpha", position: 3, url: "https://rival.com/b" },
  ]);
  // Tighten the cut to top-2: only the position-1 row survives.
  const tight = competitorRowsFromQueries(seeded, "rival.com", 2);
  assert.equal(tight.length, 1);
  assert.equal(tight[0].keyword, "beta");
});

test("extractKeywordCandidates pulls clean H1/H2 phrases and splits brand suffixes", () => {
  const page = {
    title: "Best SARMs for Cutting — ShopNootropics",
    headings: [
      "H1: Best SARMs for cutting in 2026",
      "H2: Ostarine dosage guide",
      "H3: deep heading is ignored",
      "H2: Home",
      "H1: Best SARMs for Cutting — ShopNootropics",
      "H2: Legal",
      "H2: Where to buy rad 140 online safely",
      "H1: x",
    ],
  };
  const out = extractKeywordCandidates(page, 6);
  assert.deepEqual(out, [
    "Best SARMs for Cutting",
    "Best SARMs for cutting in 2026",
    "Ostarine dosage guide",
    "Where to buy rad 140 online safely",
  ]);
  assert.equal(extractKeywordCandidates({ title: "", headings: [] }).length, 0);
});
