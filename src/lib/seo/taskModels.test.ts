import { test } from "node:test";
import assert from "node:assert/strict";
import { taskModelFor } from "./taskModels";

// Link Monitor insights and the other structured tasks must never ride the reasoning flagship:
// it spends its whole output budget thinking and returns empty text at a short ask (see the
// measured table at the top of taskModels.ts).

test("insights resolves a measured non-reasoning default on ollama", () => {
  assert.equal(taskModelFor("ollama", "insights"), "mimo-v2.6-flash");
});

test("insights keeps caller-provided behaviour on providers with no measured default", () => {
  assert.equal(taskModelFor("openai", "insights"), "");
});

test("INSIGHTS_AI_MODEL env overrides the measured default", () => {
  process.env.INSIGHTS_AI_MODEL = "custom-model";
  try {
    assert.equal(taskModelFor("ollama", "insights"), "custom-model");
  } finally {
    delete process.env.INSIGHTS_AI_MODEL;
  }
});
