// Task-scoped model defaults.
//
// One model does not fit every job. The account's flagship chat model
// (`deepseek-v4.1-flash:1017-cloud`) is a *reasoning* model: on a short JSON classification it
// spends its entire output budget thinking and returns nothing, and on a 25-section outline fed
// ten competitor pages it burns the budget on hidden reasoning and stops mid-JSON.
//
// Measured on this deployment (2026-11-16, Ollama Cloud, 10 scraped competitors, 24000-token ask):
//
//   outline        gpt-oss:120b          35s  45 sections, faq 5, entity_analysis  complete JSON
//                  deepseek-v4.1-flash:1017  129s  10 sections, no faq, no entity  TRUNCATED
//                  kimi-k3               185s   4 sections, no faq                 TRUNCATED
//                  mimo-v2.6-flash       105s  empty completion                   NO TEXT
//
//   citations      mimo-v2.6-flash        1.3s  correct positive/unclear/neutral on an AR batch
//                  gpt-oss:20b           3.2s  correct
//                  minimax-m3.1-flash    4.8s  correct
//                  deepseek-v4.1-flash:1017  0/3 batches produced any text
//
// So the two structured tasks get their own defaults, keyed by provider. These are *defaults*: an
// explicit `seoModel`, a per-task `seoTaskModel_<task>`, or the task's env var always wins, and the
// global AI provider/model default is never touched.

export type StructuredTask = "outline" | "citations" | "insights";

const TASK_MODELS: Record<string, Partial<Record<StructuredTask, string>>> = {
  ollama: {
    outline: "gpt-oss:120b",
    citations: "mimo-v2.6-flash",
    // Insights summarization over Link Monitor rows: same failure mode as citations on the
    // reasoning flagship (whole budget spent thinking, empty text). The measured non-reasoning
    // flash model handles the long-row summary reliably.
    insights: "mimo-v2.6-flash",
  },
};

/** Env var a deployment can use to override a task model without a rebuild. */
export const TASK_MODEL_ENV: Record<StructuredTask, string> = {
  outline: "OUTLINE_AI_MODEL",
  citations: "CITATIONS_AI_MODEL",
  insights: "INSIGHTS_AI_MODEL",
};

/**
 * The model a structured task should run on when the caller named none.
 * Returns "" for providers with no measured default — the caller then keeps its own behaviour.
 */
export function taskModelFor(provider: string, task: StructuredTask): string {
  const fromEnv = (process.env[TASK_MODEL_ENV[task]] || "").trim();
  if (fromEnv) return fromEnv;
  return TASK_MODELS[String(provider || "").trim().toLowerCase()]?.[task] || "";
}
