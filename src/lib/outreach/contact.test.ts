// Pure halves of contact discovery: robots parsing, disallow matching, email extraction.
// The email half carries the "never fabricate" rule — a test here is a contract test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRobots, disallowsPath, extractEmails } from "./contactPure";

test("parseRobots reads the star group only and ignores comments/other groups", () => {
  const disallow = parseRobots(`
# comment
User-agent: Googlebot
Disallow: /private-g

User-agent: *
Disallow: /admin
Disallow: /contact   # disallowed for us
Allow: /
`);
  assert.deepEqual(disallow, ["/admin", "/contact"]);
});

test("parseRobots on garbage/empty robots.txt yields no restrictions (proceed)", () => {
  assert.deepEqual(parseRobots(""), []);
  assert.deepEqual(parseRobots("!!!not robots!!!"), []);
});

test("disallowsPath matches prefixes, ignores wildcard extensions, and allows the rest", () => {
  const rules = ["/admin", "/contact"];
  assert.equal(disallowsPath(rules, "/contact"), true);
  assert.equal(disallowsPath(rules, "/contact-us"), true); // prefix semantics, like real crawlers
  assert.equal(disallowsPath(rules, "/about"), false);
  assert.equal(disallowsPath(["/*.pdf$"], "/x.pdf"), false); // wildcard rules: under-enforced on purpose
});

test("extractEmails keeps only literally-published, usable addresses and prefers on-domain mailtos", () => {
  const text = [
    "Contact us at [mail](mailto:Team@Publisher.com) or editor@publisher.com.",
    "Press: press@publisher.com; junk: logo.png@x, photo.jpg@y, noreply@sentry.io,",
    "someone@example.com, user@domain.com, info@other-site.org",
  ].join("\n");
  const out = extractEmails(text, "publisher.com");
  assert.deepEqual(out, ["team@publisher.com", "editor@publisher.com", "press@publisher.com", "info@other-site.org"]);
});

test("extractEmails finds nothing in text without an address — and never invents one", () => {
  assert.deepEqual(extractEmails("A contact form lives at https://site.com/contact — that is all.", "site.com"), []);
  assert.deepEqual(extractEmails("", "site.com"), []);
});

test("extractEmails drops asset look-alikes and placeholder domains outright", () => {
  const out = extractEmails("img1234@site.com photo.jpg@site.com a@example.com mail@YourDomain.com", "site.com");
  assert.deepEqual(out, []);
});
