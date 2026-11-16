// The approval gate's pure halves. These tests are contracts: if any of them has to change to
// accommodate a feature, the feature is probably weakening the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { countContactedToday, parseDrafts } from "./drafts";

test("countContactedToday counts only confirmations since UTC midnight", () => {
  const now = new Date("2026-11-16T15:00:00.000Z"); // 15:00 UTC
  const today = (h: number) => new Date(`2026-11-16T${String(h).padStart(2, "0")}:00:00.000Z`);
  const yesterday = new Date("2026-11-15T23:59:00.000Z");
  const used = countContactedToday(now, [today(1), today(9), today(14), yesterday]);
  assert.equal(used, 3);
  assert.equal(countContactedToday(now, []), 0);
});

test("parseDrafts extracts initial + follow-ups from fenced/prose-wrapped JSON", () => {
  const raw = `Here you go:
\`\`\`json
{"initial":{"subject":"Hi","body":"Great resource roundup...","rationale":"their listicle fits"},
 "followups":[{"subject":"Re: Hi","body":"Bumping gently","rationale":"nudge"}]}
\`\`\``;
  const parsed = parseDrafts(raw);
  assert.ok(parsed);
  assert.equal(parsed.initial.subject, "Hi");
  assert.equal(parsed.initial.body, "Great resource roundup...");
  assert.equal(parsed.followups.length, 1);
});

test("parseDrafts refuses to fabricate: no body means no draft, garbage means null", () => {
  assert.equal(parseDrafts(null), null);
  assert.equal(parseDrafts(""), null);
  assert.equal(parseDrafts("totally not json"), null);
  assert.equal(parseDrafts('{"initial":{"subject":"only a subject"},"followups":[]}'), null);
});

test("parseDrafts caps follow-ups at two", () => {
  const raw = JSON.stringify({
    initial: { subject: "s", body: "b", rationale: "" },
    followups: [1, 2, 3, 4].map(i => ({ subject: `f${i}`, body: `b${i}`, rationale: "" })),
  });
  assert.equal(parseDrafts(raw)?.followups.length, 2);
});
