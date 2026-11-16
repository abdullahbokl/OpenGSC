import { test } from "node:test";
import assert from "node:assert/strict";
import { compactCompetitorPages, CONTEXT_BUDGET_CHARS } from "./competitorContext";

function page(url: string, text: string, site_type?: string) {
  return { url, title: url, text_sample: text, site_type };
}

const MENU = "Home About Services Pricing Blog Contact us for a free quote today and save money now.";

test("boilerplate carried by three or more sources is removed", () => {
  const a = page("https://a.example/1", `${MENU} Acme CRM costs forty dollars per seat each month and includes pipelines.`);
  const b = page("https://b.example/2", `${MENU} Acme CRM supports custom fields, automations and a mobile app for sales.`);
  const c = page("https://c.example/3", `${MENU} Acme CRM integrates with email providers and offers a free trial tier.`);
  const { items, stats } = compactCompetitorPages([a, b, c]);

  assert.equal(stats.sources_kept, 3);
  assert.ok(stats.boilerplate_lines >= 1, "the shared menu line should be counted as boilerplate");
  for (const item of items) {
    assert.doesNotMatch(String(item.text_sample), /free quote today/);
    assert.match(String(item.text_sample), /Acme CRM/);
  }
});

test("a syndicated duplicate does not eat a second slot", () => {
  const body = "Acme CRM is a customer relationship platform with pipelines, automations and reporting dashboards for small teams.";
  const { items, stats } = compactCompetitorPages([
    page("https://a.example/1", body),
    page("https://syndicated.example/2", body),
    page("https://b.example/3", "Zeta CRM focuses on invoicing, expense tracking and accountant collaboration for freelancers."),
  ]);

  assert.equal(stats.dropped_duplicate, 1);
  assert.equal(stats.sources_kept, 2);
  // The dropped page still travels as a title-only row so the outline knows it exists.
  assert.equal(items.length, 3);
  assert.equal(items.find((i) => i.url === "https://syndicated.example/2")?.text_sample, undefined);
});

test("the total context fits the budget and official sources are kept first", () => {
  // Distinct wording per source, so this tests the BUDGET and not the duplicate detector.
  const long = (tag: string) => Array.from({ length: 600 }, (_, i) => `${tag}${i}`).join(" "); // ~20 KB each
  const pages = [
    page("https://blog.example/1", `${long("blog")} blog one`),
    page("https://shop.example/2", `${long("shop")} official store`, "official_store"),
    page("https://news.example/3", `${long("news")} news three`),
    page("https://other.example/4", `${long("other")} other four`),
  ];
  const { items, stats } = compactCompetitorPages(pages, 8000);

  assert.ok(stats.chars_out <= 8000, `context should fit the budget, got ${stats.chars_out}`);
  assert.equal(stats.sources_kept, items.filter((i) => i.text_sample).length);
  assert.equal(items[0].url, "https://shop.example/2", "the official source keeps the first slot");
});

test("Arabic pages compact without losing their sentences", () => {
  const shared = "اتصل بنا للحصول على عرض سعر مجاني اليوم ووفر المال الآن مع خدماتنا المتميزة.";
  const pages = [
    page("https://a.example/ar", `${shared} تقدم أرامكو السعودية حلولاً في مجال الطاقة والنفط والغاز.`),
    page("https://b.example/ar", `${shared} أعلنت أرامكو عن نتائج مالية قوية فاقت توقعات المحللين.`),
    page("https://c.example/ar", `${shared} تأسست أرامكو السعودية عام ١٩٣٣ ويقع مقرها في الظهران.`),
  ];
  const { items, stats } = compactCompetitorPages(pages);
  assert.equal(stats.sources_kept, 3);
  for (const item of items) {
    assert.match(String(item.text_sample), /أرامكو/);
    assert.doesNotMatch(String(item.text_sample), /عرض سعر مجاني/);
  }
});

test("pages with no usable text are passed through untouched", () => {
  const pages = [page("https://a.example/1", ""), page("https://b.example/2", "short")];
  const { items, stats } = compactCompetitorPages(pages);
  assert.equal(stats.sources_in, 2);
  assert.equal(stats.sources_kept, 0);
  assert.equal(items.length, 2);
});

test("the default budget is what the outline step advertises", () => {
  assert.equal(CONTEXT_BUDGET_CHARS, 24000);
});
