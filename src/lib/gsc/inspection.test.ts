import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyInspectionFailure, inspectionSiteUrl } from "./inspection";

test("domain properties are passed to URL Inspection unchanged", () => {
  assert.equal(inspectionSiteUrl("sc-domain:albokl.com"), "sc-domain:albokl.com");
  assert.equal(inspectionSiteUrl("https://albokl.com/"), "https://albokl.com/");
  assert.equal(inspectionSiteUrl(" https://example.com/blog/ "), "https://example.com/blog/");
});

test("inspection failures map to the reason the UI can explain", () => {
  assert.equal(classifyInspectionFailure(403), "property_forbidden");
  assert.equal(classifyInspectionFailure(401), "auth_expired");
  assert.equal(classifyInspectionFailure(429), "quota_exhausted");
  assert.equal(classifyInspectionFailure(400), "invalid_request");
  assert.equal(classifyInspectionFailure(500), "api_error");
  assert.equal(classifyInspectionFailure(404), "api_error");
});
