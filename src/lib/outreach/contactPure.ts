// Pure halves of contact discovery — no imports, so the never-fabricate rules are testable
// without the fetch/crawl stack. contact.ts uses these; the tests import this file directly.

export interface RobotsPolicy {
  checked: boolean;
  disallow: string[];
}

/** Parse the site's robots.txt into the `User-agent: *` disallow list. A missing or unreadable
 *  robots.txt means "no published restrictions", not "blocked" — we proceed. */
export function parseRobots(text: string): string[] {
  const lines = text.split(/\r?\n/);
  let inStar = false;
  const disallow: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = /^(user-agent|disallow)\s*:\s*(.*)$/i.exec(t);
    if (!m) { inStar = false; continue; }
    if (/^user-agent$/i.test(m[1])) { inStar = stripComment(m[2]).trim() === "*"; continue; }
    if (inStar) {
      const path = stripComment(m[2]).trim();
      if (path) disallow.push(path);
    }
  }
  return disallow;
}

export function disallowsPath(disallow: string[], path: string): boolean {
  for (const rule of disallow) {
    // Only the prefix form is enforced; wildcards and other extensions are treated as absent
    // (we under-block, never over-block, and only for pages we would read manually anyway).
    if (rule.includes("*") || rule.includes("$")) continue;
    if (path.startsWith(rule) || path === rule) return true;
  }
  return false;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Addresses literally present in the text. Unusable look-alikes (assets, placeholders,
 *  well-known no-reply bots) are dropped, not "cleaned up" — a dropped address means the page
 *  did not publish a usable contact, and guessing would be worse than silence. Pure. */
export function extractEmails(text: string, siteDomain: string): string[] {
  const found = new Map<string, string>();
  const mailtos = text.matchAll(/mailto:([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi);
  for (const m of mailtos) found.set(m[1].toLowerCase(), "mailto");
  for (const m of text.match(EMAIL_RE) ?? []) found.set(m.toLowerCase(), found.get(m.toLowerCase()) ?? "text");
  // Assets leak in two shapes: an asset extension on the domain ("photo@x.com.jpg") and a
  // filename for the local part ("photo.jpg@x.com"). Both are dropped, plus the well-known
  // no-reply/placeholder hosts that can never be a human contact.
  const bad = /\.(png|jpe?g|gif|webp|svg|css|js|woff2?)$|^[^@]*\.(png|jpe?g|gif|webp|svg|css|js|woff2?)@|^(img|image|photo|logo|icon|banner|avatar|screenshot|thumb)[\d_-]*@|@sentry\.io$|@wixpress\.com$|example\.(com|org)$|@2x$|domain\.com$|email\.com$|your(domain|email)\./;
  const domain = siteDomain.toLowerCase();
  const scored: { email: string; via: string; onDomain: boolean }[] = [];
  for (const [email, via] of found) {
    if (bad.test(email)) continue;
    // Obfuscations that survived ("name at site dot com") never match the regex, by design.
    const host = email.split("@")[1] ?? "";
    scored.push({ email, via, onDomain: host === domain || host.endsWith(`.${domain}`) });
  }
  // On-domain first (the site's own mailbox), then third-party addresses that appear as
  // mailto links (a real clickable contact), then any plain-text address.
  scored.sort((a, b) => (a.onDomain === b.onDomain ? (a.via === b.via ? 0 : a.via === "mailto" ? -1 : 1) : a.onDomain ? -1 : 1));
  return scored.map(s => s.email);
}

/** robots.txt values may carry a trailing `# comment` — the field ends at the first #. */
function stripComment(value: string): string {
  const i = value.indexOf("#");
  return i < 0 ? value : value.slice(0, i);
}
