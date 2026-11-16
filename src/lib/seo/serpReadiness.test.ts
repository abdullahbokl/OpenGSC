import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSerpProvider, serpConfigReady, serpCredsReady, serpProviderNeedsKey, serpProviderOrDefault } from "./serpReadiness";

test("SearXNG is the only keyless provider", () => {
  assert.equal(serpProviderNeedsKey("searxng"), false);
  assert.equal(serpProviderNeedsKey("serper"), true);
  assert.equal(serpProviderNeedsKey("dataforseo"), true);
  assert.equal(serpProviderNeedsKey("aparser"), true);
});

test("serpConfigReady accepts SearXNG without a key and still requires keys elsewhere", () => {
  assert.equal(serpConfigReady("searxng", ""), true);
  assert.equal(serpConfigReady("searxng", undefined), true);
  assert.equal(serpConfigReady("serper", ""), false);
  assert.equal(serpConfigReady("serper", "  "), false);
  assert.equal(serpConfigReady("serper", "sp-key"), true);
});

test("serpCredsReady mirrors the credential shape used by the browser", () => {
  assert.equal(serpCredsReady({ provider: "searxng", apiKey: "" }), true);
  assert.equal(serpCredsReady({ provider: "dataforseo" }), false);
  assert.equal(serpCredsReady({ provider: "dataforseo", apiKey: "login:pass" }), true);
});

test("an explicit provider always wins", () => {
  const hasKey = () => true;
  assert.equal(pickSerpProvider("dataforseo", hasKey), "dataforseo");
  assert.equal(pickSerpProvider("searxng", hasKey), "searxng");
});

test("with no choice, the first configured commercial provider keeps its behaviour", () => {
  assert.equal(pickSerpProvider("", (p) => p === "serper"), "serper");
  assert.equal(pickSerpProvider(null, (p) => p === "dataforseo"), "dataforseo");
  // A configured Serper key outranks a configured DataForSEO one, in the documented order.
  assert.equal(pickSerpProvider(undefined, () => true), "serper");
});

test("a keyless install resolves to SearXNG on both sides of the wire", () => {
  // Browser: pickSerpProvider with no stored choice and no keys.
  assert.equal(pickSerpProvider("", () => false), "searxng");
  // Server: a payload that carried no provider at all.
  assert.equal(serpProviderOrDefault(undefined), "searxng");
  assert.equal(serpProviderOrDefault(""), "searxng");
  assert.equal(serpProviderOrDefault("   "), "searxng");
  // ...and an explicit one is untouched.
  assert.equal(serpProviderOrDefault("serper"), "serper");
});

test("the server default is ready without a key, which is the whole point", () => {
  assert.equal(serpConfigReady(serpProviderOrDefault(undefined), ""), true);
  // The old default was not: this is the divergence the helper removes.
  assert.equal(serpConfigReady("serper", ""), false);
});
