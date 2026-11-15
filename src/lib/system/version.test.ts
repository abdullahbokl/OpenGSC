import { test } from "node:test";
import assert from "node:assert/strict";
import { mapCompare, parseRepoSlug } from "./version";

test("parseRepoSlug: https + .git", () => {
  assert.equal(parseRepoSlug("https://github.com/abdullahbokl/OpenGSC.git"), "abdullahbokl/OpenGSC");
});

test("parseRepoSlug: https without .git, trailing slash", () => {
  assert.equal(parseRepoSlug("https://github.com/fenjo26/opengsc/"), "fenjo26/opengsc");
});

test("parseRepoSlug: ssh form", () => {
  assert.equal(parseRepoSlug("git@github.com:fenjo26/opengsc.git"), "fenjo26/opengsc");
});

test("parseRepoSlug: non-github or garbage -> null", () => {
  assert.equal(parseRepoSlug("https://gitlab.com/o/r.git"), null);
  assert.equal(parseRepoSlug("not-a-url"), null);
  assert.equal(parseRepoSlug(""), null);
});

// mapCompare contract: malformed input can never produce a false "update available".
test("mapCompare: full compare payload -> behind + reversed changelog, merge commits hidden", () => {
  const cmp = {
    ahead_by: 3,
    total_commits: 99,
    commits: [
      { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", commit: { message: "oldest\n\nbody", author: { date: "2026-11-14T00:00:00Z" } } },
      { sha: "bbbbbbbb", commit: { message: "merge branch x", author: { date: "2026-11-14T01:00:00Z" } } },
      { sha: "cccccccc", commit: { message: "newest", author: { date: "2026-11-15T02:00:00Z" } } },
    ],
  };
  const { behind, changelog } = mapCompare(cmp);
  assert.equal(behind, 3);
  assert.deepEqual(changelog.map(e => e.sha), ["ccccccc", "aaaaaaa"]);
  assert.equal(changelog.some(e => /^merge /i.test(e.message)), false);
  assert.equal(changelog[1].message, "oldest");
  assert.equal(changelog[0].date, "2026-11-15T02:00:00Z");
});

test("mapCompare: null / garbage / missing fields -> behind 0, no changelog", () => {
  assert.deepEqual(mapCompare(null), { behind: 0, changelog: [] });
  assert.deepEqual(mapCompare("garbage"), { behind: 0, changelog: [] });
  assert.deepEqual(mapCompare({}), { behind: 0, changelog: [] });
  assert.deepEqual(mapCompare({ commits: "not-an-array" }), { behind: 0, changelog: [] });
});

test("mapCompare: string ahead_by (malformed) is ignored -> behind 0", () => {
  assert.equal(mapCompare({ ahead_by: "5" }).behind, 0);
});

test("mapCompare: negative ahead_by is clamped to 0", () => {
  assert.equal(mapCompare({ ahead_by: -2, commits: [] }).behind, 0);
});

test("mapCompare: total_commits fallback when ahead_by missing", () => {
  assert.equal(mapCompare({ total_commits: 7 }).behind, 7);
});
