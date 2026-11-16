// URL Inspection property handling.
//
// The URL Inspection API accepts the property exactly as Search Console reports it, including a
// domain property (`sc-domain:example.com`). Rewriting it to a URL-prefix (`https://example.com/`)
// was a real bug: Google answered 403 "You do not own this site" for every domain property, and
// the UI reported that as "connect a Google account with GSC access" even though the account was
// connected and owned the property.
//
// Keep this pure so the exact property identity is unit-tested without touching Google.

export function inspectionSiteUrl(siteId: string): string {
  return String(siteId ?? "").trim();
}

export type InspectionFailure =
  | "property_forbidden"
  | "auth_expired"
  | "quota_exhausted"
  | "invalid_request"
  | "api_error";

/** Map an HTTP failure from URL Inspection to the reason the UI should show. */
export function classifyInspectionFailure(status: number): InspectionFailure {
  if (status === 429) return "quota_exhausted";
  if (status === 401) return "auth_expired";
  if (status === 403) return "property_forbidden";
  if (status === 400) return "invalid_request";
  return "api_error";
}
