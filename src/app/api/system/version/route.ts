import { NextResponse } from "next/server";
import { workspaceUserId } from "@/lib/team/workspace";
import { promisify } from "util";
import { exec as execCb } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { mapCompare, parseRepoSlug } from "@/lib/system/version";

const exec = promisify(execCb);

// Human-friendly semantic version from package.json (e.g. "1.0.0"). Bumped manually per
// release; shown in the UI alongside the git commit (which drives update detection).
function pkgVersion(): string {
  try { return JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version || ""; }
  catch { return ""; }
}

// GET /api/system/version
// Compares the locally-checked-out git commit with the latest commit on the UPDATE SOURCE —
// the same remote/branch update.sh pulls from: UPDATE_REMOTE/UPDATE_BRANCH in .env, defaults
// fork/main. origin (fenjo26/opengsc) stays upstream reference only; comparing against it
// would false-alarm when upstream moves ahead of the fork. Resolves the remote name to a
// GitHub owner/repo slug via `git config remote.<name>.url`, so the banner and the updater
// can never disagree about what "update available" means. No secrets — reads the public repo.
// Used by the dashboard "update available" banner.

const REMOTE = process.env.UPDATE_REMOTE || "fork";
const BRANCH = process.env.UPDATE_BRANCH || "main";

async function localCommit(): Promise<string | null> {
  try {
    const { stdout } = await exec("git rev-parse HEAD", { cwd: process.cwd(), timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// Remote name -> GitHub owner/repo slug. The name is env-supplied, so it is restricted to the
// characters a git remote name can legally contain before it ever reaches a shell.
async function repoSlug(): Promise<string | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(REMOTE)) return null;
  try {
    const { stdout } = await exec(`git config --get remote.${REMOTE}.url`, { cwd: process.cwd(), timeout: 5000 });
    return parseRepoSlug(stdout.trim());
  } catch {
    return null;
  }
}

export async function GET() {
  const workspaceId = await workspaceUserId();
  if (!workspaceId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const local = await localCommit();
  if (!local) {
    // Not a git checkout (e.g. Docker image) — self-update from UI isn't possible.
    return NextResponse.json({ isGit: false, updateAvailable: false, version: pkgVersion() });
  }

  const repo = await repoSlug();
  if (!repo) {
    // Update source not resolvable (remote missing or URL unparsable): never report an update.
    return NextResponse.json({ isGit: true, local: local.slice(0, 7), updateAvailable: false, version: pkgVersion(), error: `update source ${REMOTE}/${BRANCH} not resolvable` });
  }

  try {
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "opengsc" };
    // Latest commit on the update branch
    const relRes = await fetch(`https://api.github.com/repos/${repo}/commits/${BRANCH}`, { headers, signal: AbortSignal.timeout(10000) });
    if (!relRes.ok) return NextResponse.json({ isGit: true, local, updateAvailable: false, error: `github ${relRes.status}` });
    const latest = await relRes.json();
    const remote = String(latest.sha ?? "");

    if (!remote || remote === local) {
      return NextResponse.json({ isGit: true, version: pkgVersion(), local: local.slice(0, 7), remote: remote.slice(0, 7), behind: 0, updateAvailable: false });
    }

    // How far behind + changelog (commit subjects between local and remote). Best-effort:
    // a compare failure still yields updateAvailable: false via mapCompare's defaults.
    let behind = 0;
    let changelog: { sha: string; message: string; date: string }[] = [];
    try {
      const cmpRes = await fetch(`https://api.github.com/repos/${repo}/compare/${local}...${remote}`, { headers, signal: AbortSignal.timeout(10000) });
      if (cmpRes.ok) {
        ({ behind, changelog } = mapCompare(await cmpRes.json()));
      }
    } catch { /* compare is best-effort — the update flag still works without it */ }

    return NextResponse.json({
      isGit: true,
      version: pkgVersion(),
      local: local.slice(0, 7),
      remote: remote.slice(0, 7),
      behind,
      // behind, not remote !== local: an install parked on a newer branch (testing ahead of main)
      // must not see the update bar — its "Update now" would reset it backwards.
      updateAvailable: behind > 0,
      changelog,
    });
  } catch (e) {
    return NextResponse.json({ isGit: true, local: local.slice(0, 7), updateAvailable: false, error: String((e as Error)?.message ?? e) });
  }
}
