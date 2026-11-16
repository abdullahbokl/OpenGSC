// Which SERP providers can be configured without an API key.
//
// Kept free of Prisma and of any network call so the same predicate is safe in a server job and
// in a client component. SearXNG is the only keyless provider today: its credential is the
// instance URL, which lives in the server environment and is never sent by the browser.
//
// "Ready here" is a configuration check, not a health check. The Settings card and
// `/api/seo/serp/searxng/status` do the deep probe (a real search) before claiming a connection.

export const SEARXNG_PROVIDER_ID = "searxng";

/** Providers that carry an app-wide SERP key, in the order the old default tried them. */
export const APP_WIDE_SERP_PROVIDER_IDS = ["serper", "dataforseo", "scrapingrobot", "goanyapi"] as const;

/**
 * Resolve the effective SERP provider from a stored choice plus which keys exist.
 *
 * Shared by browser and server so "no provider selected" cannot mean Serper in one place and
 * something else in another. An explicit choice always wins; otherwise the first configured
 * commercial provider keeps its old behaviour, and a keyless install falls through to SearXNG.
 */
export function pickSerpProvider(stored: unknown, hasKey: (provider: string) => boolean): string {
  const chosen = String(stored ?? "").trim();
  if (chosen) return chosen;
  for (const provider of APP_WIDE_SERP_PROVIDER_IDS) {
    if (hasKey(provider)) return provider;
  }
  return SEARXNG_PROVIDER_ID;
}

/**
 * Server-side default for a payload that carried no provider at all.
 *
 * The browser always resolves a provider (`pickSerpProvider`) and sends it with every request, so a
 * payload without one came from a script, an older job, or an MCP caller. Defaulting those to
 * "serper" was the server half of the divergence this module exists to remove: on a keyless
 * installation `serpConfigReady("serper", "")` is false, so a job SearXNG could have served came
 * back `no_serp_key`. The keyless provider is the only honest default when nothing was chosen.
 */
export function serpProviderOrDefault(stored: unknown): string {
  return String(stored ?? "").trim() || SEARXNG_PROVIDER_ID;
}

/** True when the provider needs an API key in addition to (or instead of) a host. */
export function serpProviderNeedsKey(provider: string): boolean {
  return provider !== SEARXNG_PROVIDER_ID;
}

/**
 * True when the caller has enough configuration to attempt a search.
 *
 * For SearXNG that is always true on the server: the base URL is server-side configuration.
 * A misconfigured or unreachable instance still fails at call time with a specific error code,
 * which is the right place to discover it — not silently as "no key configured".
 */
export function serpConfigReady(provider: string, apiKey?: string | null): boolean {
  if (!serpProviderNeedsKey(provider)) return true;
  return String(apiKey ?? "").trim().length > 0;
}

/** The credential shape the browser hands to a request/job. */
export interface SerpCredentialLike {
  provider: string;
  apiKey?: string;
}

/** Client-side mirror of `serpConfigReady` for the localStorage credential shape. */
export function serpCredsReady(creds: SerpCredentialLike): boolean {
  return serpConfigReady(creds.provider, creds.apiKey);
}
