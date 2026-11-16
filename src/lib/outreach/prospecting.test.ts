// Pure halves of the discovery pipeline — the parts where a wrong guess would put a fabricated
// metric or a competitor into the operator's workspace.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDiscoveryQueries,
  filterCandidates,
  parseQualification,
  QUALIFY_THRESHOLD,
} from "./prospecting";

test("discovery queries exist for every pattern and none for an empty keyword", () => {
  for (const pattern of ["resource", "listicle", "guest_post", "article"] as const) {
    const queries = buildDiscoveryQueries("keto coffee", pattern);
    assert.ok(queries.length >= 1, pattern);
    for (const q of queries) assert.ok(q.includes("keto coffee"), q);
  }
  assert.deepEqual(buildDiscoveryQueries("  ", "resource"), []);
});

test("filterCandidates drops own domains, existing prospects, duplicates, excludes and noise URLs", () => {
  const own = new Set(["myshop.com"]);
  const existing = new Set(["already-saved.com"]);
  const results = [
    { url: "https://myshop.com/blog", title: "own", snippet: "", domain: "www.myshop.com" },
    { url: "https://already-saved.com/post", title: "saved", snippet: "", domain: "already-saved.com" },
    { url: "https://b.com/a", title: "first", snippet: "", domain: "b.com" },
    { url: "https://b.com/b", title: "same domain again", snippet: "", domain: "b.com" },
    { url: "https://excluded.com/x", title: "excluded", snippet: "", domain: "excluded.com" },
    { url: "https://c.com/login", title: "noise", snippet: "", domain: "c.com" },
    { url: "https://d.com/resource", title: "good", snippet: "", domain: "d.com" },
    { url: "", title: "no url", snippet: "", domain: "e.com" },
  ];
  const out = filterCandidates(results, { ownDomains: own, existingDomains: existing, excludeDomains: ["excluded.com"] });
  assert.deepEqual(out.map(c => c.domain), ["b.com", "d.com"]);
});

test("parseQualification clamps scores, flags competitors, and keeps skipped candidates unscored", () => {
  const candidates = [
    { url: "https://a.com/x", title: "A", snippet: "", domain: "a.com" },
    { url: "https://b.com/y", title: "B", snippet: "", domain: "b.com" },
  ];
  const raw = JSON.stringify([
    { url: "https://a.com/x", score: 99, reason: "great fit", competitor: true },
  ]);
  const out = parseQualification(raw, candidates);
  assert.equal(out.length, 2);
  const a = out.find(q => q.url === "https://a.com/x")!;
  assert.equal(a.score, 10); // clamped, not 99
  assert.equal(a.competitor, true);
  const b = out.find(q => q.url === "https://b.com/y")!;
  assert.equal(b.score, 0);
  assert.equal(b.reason, "not_scored_by_model");
});

test("parseQualification degrades to UNSCORED, never to invented scores, when the model answer is garbage", () => {
  const candidates = [
    { url: "https://a.com/x", title: "A", snippet: "", domain: "a.com" },
    { url: "https://b.com/y", title: "B", snippet: "", domain: "b.com" },
  ];
  for (const raw of [null, "", "I think these are all great sites!", "```json\nnot json\n```", "{}"]) {
    const out = parseQualification(raw, candidates);
    assert.equal(out.length, candidates.length);
    for (const q of out) {
      assert.equal(q.score, 0);
      assert.equal(q.reason, "qualification_unavailable");
      assert.equal(q.competitor, false);
    }
  }
});

test("parseQualification accepts a fenced JSON array and ignores unknown urls", () => {
  const candidates = [{ url: "https://a.com/x", title: "A", snippet: "", domain: "a.com" }];
  const raw = 'Sure! ```json\n[{"url":"https://a.com/x","score":7.4,"reason":"resource page"},{"url":"https://stranger.com","score":9,"reason":"ignored"}]\n```';
  const out = parseQualification(raw, candidates);
  assert.equal(out.length, 1);
  assert.equal(out[0].score, 7.4);
});

test("the qualify threshold keeps unscored candidates but drops low-scored ones", () => {
  assert.ok(QUALIFY_THRESHOLD >= 1 && QUALIFY_THRESHOLD <= 10);
});
