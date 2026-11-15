// Update-source resolution and GitHub compare mapping, shared by /api/system/version.
//
// The update source is the fork this install maintains its own commits on — the same
// UPDATE_REMOTE / UPDATE_BRANCH configuration update.sh reads from .env (defaults fork/main,
// mirroring the updater). origin (fenjo26/opengsc) is third-party upstream, kept for reference
// only: comparing against it would false-alarm whenever upstream moves ahead of the fork, and
// the "Update now" it advertises would fast-forward to the fork, not to upstream.

/** GitHub owner/repo slug from a remote URL ("https://github.com/o/r.git",
 *  "git@github.com:o/r.git", "https://github.com/o/r/"). Null when unparseable. */
export function parseRepoSlug(url: string): string | null {
  const m = /(?:github\.com[:/]|github\.com\/)([^/\s:]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export interface ChangelogEntry { sha: string; message: string; date: string }

/** Map a GitHub compare payload to { behind, changelog }. Best-effort by contract: any
 *  malformed or missing input yields behind 0 / empty changelog so a broken response can
 *  never surface as a false "update available". */
export function mapCompare(cmp: unknown): { behind: number; changelog: ChangelogEntry[] } {
  if (!cmp || typeof cmp !== "object") return { behind: 0, changelog: [] };
  const c = cmp as { ahead_by?: unknown; total_commits?: unknown; commits?: unknown };
  const raw =
    typeof c.ahead_by === "number" ? c.ahead_by :
    typeof c.total_commits === "number" ? c.total_commits : 0;
  const behind = Math.max(0, raw);
  const changelog = (Array.isArray(c.commits) ? c.commits : [])
    .slice(-30)
    .reverse()
    .map((v: unknown) => {
      const e = (v ?? {}) as { sha?: unknown; commit?: { message?: unknown; author?: { date?: unknown } } };
      return {
        sha: String(e.sha ?? "").slice(0, 7),
        message: String(e.commit?.message ?? "").split("\n")[0],
        date: typeof e.commit?.author?.date === "string" ? e.commit.author.date : "",
      };
    })
    // Hide noise
    .filter((e) => e.message && !/^merge /i.test(e.message));
  return { behind, changelog };
}
