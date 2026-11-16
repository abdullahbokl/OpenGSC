// The registry mirror's pure halves: external-ref stability (dedup depends on it) and the
// find-by-reference pick. Everything network-shaped is exercised in production with the real
// registry; these pin the logic that must never fork a record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findByRef, placementRef } from "./refs";

test("placementRef is deterministic per normalized pair + provider and bounded", () => {
  const a = placementRef("https://donor.com/post", "https://mine.com/page", "fieldlink");
  const b = placementRef("https://donor.com/post", "https://mine.com/page", "fieldlink");
  const c = placementRef("https://donor.com/post", "https://mine.com/page", "magic369");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a.startsWith("ogsc-fieldlink-"));
  assert.ok(a.length <= 300);
  const long = placementRef(`https://${"x".repeat(400)}.com/`, "https://mine.com/", "outreach");
  assert.ok(long.length <= 300); // fits the unique index, never a DB error
});

test("findByRef matches notes exactly — a prefix hit is not a match", () => {
  const links = [
    { id: 1, notes: "ogsc-fieldlink-abc|https://mine.com/", placementUrl: "https://donor.com/", targetUrl: "", anchorText: "", partnerName: "", linkType: "", particular: "", status: "pending" },
    { id: 2, notes: "ogsc-outreach-xyz", placementUrl: "https://other.com/", targetUrl: "", anchorText: "", partnerName: "", linkType: "", particular: "", status: "live" },
  ];
  assert.equal(findByRef(links, "ogsc-outreach-xyz")?.id, 2);
  assert.equal(findByRef(links, "ogsc-outreach-xy"), undefined);
  assert.equal(findByRef(links, "  ogsc-outreach-xyz  ")?.id, 2); // trailing whitespace tolerated
  assert.equal(findByRef([], "ogsc-x"), undefined);
});
