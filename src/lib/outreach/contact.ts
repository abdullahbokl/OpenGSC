// Contact discovery for Outreach Workspace prospects — the polite version.
//
// The pipeline reads a SMALL set of publicly reachable pages a human outreach sender would
// read anyway (home, /contact, /about, /write-for-us), respects robots.txt disallows for the
// paths it visits, throttles itself to one site at a time, and extracts only addresses that
// are LITERALLY PUBLISHED on those pages. It never guesses patterns (no "info@" constructions)
// and never presents an inferred address as found — when nothing reliable exists the prospect
// is honestly marked no_contact_found.
//
// Fetching rides the same scrapePage() pipeline the content tools use (direct fetch, then the
// self-hosted Crawl4AI service for anti-bot pages, then an optional Firecrawl key) so no new
// browser infrastructure is deployed, and every network hop already goes through safeFetch's
// SSRF guards.

import { safeFetch, DEFAULT_USER_AGENT } from "@/lib/security/safeFetch";
import { scrapePage } from "@/lib/seo/scrape";
import { normalizeProspectDomain } from "./types";
import { disallowsPath, extractEmails, parseRobots, type RobotsPolicy } from "./contactPure";

// Order matters: the home page first (many sites publish email there), then the standard
// contact surfaces. Bounded — five pages per prospect, not a crawl.
const CONTACT_PATHS = ["", "/contact", "/contact-us", "/about", "/write-for-us"] as const;

export interface ContactResult {
  prospectId: string;
  domain: string;
  email: string;
  contactUrl: string;
  contactSource: string;
  others: string[];
  checked: string[];
  found: boolean;
}

async function robotsFor(origin: string): Promise<RobotsPolicy> {
  try {
    const res = await safeFetch(`${origin}/robots.txt`, { headers: { "User-Agent": DEFAULT_USER_AGENT }, timeoutMs: 10_000 });
    const body = await res.text();
    return { checked: res.ok, disallow: res.ok ? parseRobots(body) : [] };
  } catch {
    return { checked: false, disallow: [] };
  }
}

/** Inspect one prospect's site for a published contact. Never throws for "nothing found" —
 *  that is a normal answer, recorded on the prospect. */
export async function findContact(userId: string, prospectId: string): Promise<ContactResult> {
  const { prisma } = await import("@/lib/prisma");
  const prospect = await prisma.outreachProspect.findFirst({ where: { id: prospectId, userId } });
  if (!prospect) throw new Error("prospect_not_found");
  const domain = normalizeProspectDomain(prospect.domain);
  if (!domain) throw new Error("prospect_domain_required");
  const origin = `https://${domain}`;

  const robots = await robotsFor(origin);
  const checked: string[] = [];
  let emails: string[] = [];
  let contactUrl = "";

  for (const path of CONTACT_PATHS) {
    if (checked.length >= 5) break;
    const pathPart = path || "/";
    if (robots.disallow.length && disallowsPath(robots.disallow, pathPart)) continue;
    const url = `${origin}${path}`;
    checked.push(url);
    try {
      const page = await scrapePage(url);
      if (!page.ok || page.boilerplateOnly) continue;
      const text = `${page.contentMarkdown}\n${page.textSample}`;
      const found = extractEmails(text, domain);
      if (found.length) {
        emails = found;
        contactUrl = url;
        break;
      }
    } catch {
      // A page that will not be read is a page with no published contact we could see. On to
      // the next candidate path — the final answer stays honest about what was checked.
    }
  }

  const primary = emails[0] ?? "";
  const result: ContactResult = {
    prospectId,
    domain,
    email: primary,
    contactUrl: primary ? contactUrl : "",
    contactSource: primary
      ? `published_email:${contactUrl}`
      : `no_contact_found:${checked.length} pages checked${robots.checked ? ", robots respected" : ""}`,
    others: emails.slice(1, 4),
    checked,
    found: !!primary,
  };

  await prisma.outreachProspect.update({
    where: { id: prospect.id },
    data: {
      contactEmail: primary,
      contactUrl: result.contactUrl,
      contactSource: result.contactSource,
    },
  });
  return result;
}
