// lib/feathertail/diff.ts — post-session worktree diff capture.
//
// Source of truth for the review patch is the worktree filesystem, not
// the SDK event stream (per Slice 0 spike memo, redesign #3). On
// transition to awaiting_review, the worker calls captureDiff(cwd) and
// persists the result to sessions.diff.
//
// Three git commands inside the worktree:
//   1. `git status --porcelain -uall` — picks up untracked files (?? prefix).
//      The `-uall` flag (= --untracked-files=all) makes git recurse into
//      untracked DIRECTORIES and emit one line per file. Without it, git's
//      default behaviour (`-unormal`) collapses untracked directories to
//      a single entry with a trailing slash — and the parser would then
//      see one "file" per directory with 0/0 line counts. Manual-run #1
//      defect.
//   2. `git diff`                   — full patch text for tracked-modified files.
//   3. `git diff --numstat`         — per-file (additions, deletions, path)
//                                     for tracked-modified files only.
//
// Plan §5 named `git diff --stat`. We use `--numstat` instead — same
// data, machine-readable form (`<add>\t<del>\t<path>` per line) avoids
// parsing the variable-width visual bar. Totals are computed by summing
// per-file counts.
//
// parseDiff is a pure function: given the three git outputs and the
// line counts for untracked files, returns a typed WorktreeDiff. The
// untracked file line counts are computed by captureDiff via real
// filesystem reads (untracked files don't appear in `git diff`, so
// numstat doesn't see them — we count their lines directly).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { WorktreeDiff as WorktreeDiffSchema } from "@/lib/types/jsonb";
import type {
  WorktreeDiff,
  WorktreeDiffFile,
  WorktreeDiffFileStatus,
} from "@/lib/feathertail/types";

const execFileP = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────
// Parser — pure. Exported for unit testing.
// ─────────────────────────────────────────────────────────────────────

export type ParseDiffInput = {
  /** `git status --porcelain` stdout. */
  porcelain: string;
  /** `git diff` stdout. Used to extract per-file patch hunks. */
  diff: string;
  /** `git diff --numstat` stdout — `<add>\t<del>\t<path>` per line. */
  numstat: string;
  /**
   * Line counts for untracked (?? in porcelain) files. The worker
   * reads each untracked file's contents and supplies the line count
   * here; the parser stays pure. Missing entry → treated as 0.
   */
  untrackedLineCounts: Record<string, number>;
};

export function parseDiff(input: ParseDiffInput): WorktreeDiff {
  const { porcelain, diff, numstat, untrackedLineCounts } = input;

  // Map: path → { additions, deletions } from --numstat. Binary files
  // show as "-\t-\tpath" → treat both as 0.
  const numstatByPath = new Map<
    string,
    { additions: number; deletions: number }
  >();
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [addStr, delStr, ...rest] = parts;
    const filePath = rest.join("\t"); // path may contain tabs (rare)
    const additions = addStr === "-" ? 0 : Number.parseInt(addStr ?? "0", 10);
    const deletions = delStr === "-" ? 0 : Number.parseInt(delStr ?? "0", 10);
    numstatByPath.set(filePath, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    });
  }

  // Map: path → unified-diff patch text from `git diff`. The output is
  // a concatenation of per-file diffs each starting with `diff --git`.
  const patchByPath = splitPatchByFile(diff);

  // Walk porcelain to classify each file. Untracked (??) → 'added'.
  // Tracked-modified (XY where X or Y is M) → 'modified'.
  // Tracked-deleted (XY where X or Y is D) → 'deleted'.
  // Renames (R) — unstaged worktree changes never show R in --porcelain,
  // so we don't expect them in practice. If a staged rename arrives,
  // we treat it as the modified case (the new path is what matters).
  const files: WorktreeDiffFile[] = [];
  for (const rawLine of porcelain.split("\n")) {
    if (!rawLine) continue;
    // Porcelain v1 format: two-char status code, space, path.
    const code = rawLine.slice(0, 2);
    const filePath = rawLine.slice(3);
    if (!filePath) continue;

    let status: WorktreeDiffFileStatus;
    let additions: number;
    let deletions: number;
    let patch: string | null;

    if (code === "??") {
      // Untracked — invisible to `git diff`. Additions = line count of
      // the new file (supplied by captureDiff); deletions = 0.
      status = "added";
      additions = untrackedLineCounts[filePath] ?? 0;
      deletions = 0;
      patch = null;
    } else if (code.includes("D")) {
      // Tracked deletion. --numstat reports the deletion; --diff shows
      // the removed content as -lines.
      status = "deleted";
      const stat = numstatByPath.get(filePath) ?? {
        additions: 0,
        deletions: 0,
      };
      additions = stat.additions;
      deletions = stat.deletions;
      patch = patchByPath.get(filePath) ?? null;
    } else {
      // Anything else (` M`, `M `, `MM`, `R ` renames-as-modified) →
      // treat as modified. Counts come from --numstat; patch from --diff.
      status = "modified";
      const stat = numstatByPath.get(filePath) ?? {
        additions: 0,
        deletions: 0,
      };
      additions = stat.additions;
      deletions = stat.deletions;
      patch = patchByPath.get(filePath) ?? null;
    }

    files.push({ path: filePath, status, additions, deletions, patch });
  }

  const totals = files.reduce(
    (acc, f) => ({
      files_changed: acc.files_changed + 1,
      additions: acc.additions + f.additions,
      deletions: acc.deletions + f.deletions,
    }),
    { files_changed: 0, additions: 0, deletions: 0 },
  );

  return { files, totals };
}

/**
 * Split a multi-file `git diff` output into a map from path → that
 * file's patch text. Each per-file patch begins with `diff --git a/X b/Y`.
 */
function splitPatchByFile(diff: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!diff.trim()) return result;
  // Split on the boundary, keeping the boundary line as part of each chunk.
  const chunks = diff.split(/^(?=diff --git )/m);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    // Extract path from the header. The header is `diff --git a/<path> b/<path>`.
    const header = chunk.split("\n", 1)[0] ?? "";
    const match = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (!match) continue;
    // Use the b-side path (post-change name) — matches the porcelain entry
    // for modified and added files. For deletions, a-side and b-side are
    // the same.
    const filePath = match[2] ?? match[1] ?? "";
    if (filePath) {
      result.set(filePath, chunk);
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────
// Orchestrator — runs the three git commands + reads untracked files.
// ─────────────────────────────────────────────────────────────────────

/**
 * Capture the worktree's current diff state as a WorktreeDiff.
 *
 * Called by the worker on transition to awaiting_review (or after kill
 * teardown, to capture partial work).
 *
 * Validates against the WorktreeDiff Zod schema before returning —
 * drift between parseDiff's output and the persisted shape surfaces as
 * a parse error rather than a silent UI bug.
 */
export async function captureDiff(cwd: string): Promise<WorktreeDiff> {
  const [porcelain, diff, numstat] = await Promise.all([
    runGit(["status", "--porcelain", "-uall"], cwd),
    runGit(["diff"], cwd),
    runGit(["diff", "--numstat"], cwd),
  ]);

  // For each untracked file, read line count. These are the files the
  // SDK created during the session — they're not in HEAD, so `git diff`
  // doesn't see them.
  const untrackedPaths: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("?? ")) untrackedPaths.push(line.slice(3));
  }
  const untrackedLineCounts: Record<string, number> = {};
  await Promise.all(
    untrackedPaths.map(async (relPath) => {
      try {
        // Read as raw Buffer (no encoding) so we can detect binary
        // files before attempting a utf8 decode. With `-uall`, the
        // parser now sees every untracked file including binaries the
        // agent might have created (images, generated bundles, etc.).
        // Counting bytes as newlines for a binary would be meaningless
        // and could pull large files into memory.
        const buffer = await readFile(path.join(cwd, relPath));
        if (isBinaryBuffer(buffer)) {
          // Match the shape used for tracked binary files (numstat
          // emits "-\t-\t<path>" for those; we report 0/0).
          untrackedLineCounts[relPath] = 0;
          return;
        }
        if (buffer.length === 0) {
          untrackedLineCounts[relPath] = 0;
          return;
        }
        const contents = buffer.toString("utf8");
        const newlines = (contents.match(/\n/g) ?? []).length;
        untrackedLineCounts[relPath] = contents.endsWith("\n")
          ? newlines
          : newlines + 1;
      } catch {
        // File may have been deleted between status and read — fail open.
        untrackedLineCounts[relPath] = 0;
      }
    }),
  );

  const parsed = parseDiff({ porcelain, diff, numstat, untrackedLineCounts });
  return WorktreeDiffSchema.parse(parsed);
}

/**
 * Heuristic binary-file detector. Scans the first 8 KB of the buffer
 * for a null byte — the same approach git uses internally for
 * binary-vs-text classification in many code paths. Cheap, correct
 * for the common cases (PNG/JPEG/binaries all contain nulls early;
 * text files including UTF-8 / UTF-16-BOM normal-form do not).
 */
function isBinaryBuffer(buffer: Buffer): boolean {
  const sampleEnd = Math.min(buffer.length, 8192);
  for (let i = 0; i < sampleEnd; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

async function runGit(args: string[], cwd: string): Promise<string> {
  // execFile (not exec) — args are passed without shell, no injection.
  // 10 MB buffer; large diffs from heavy sessions shouldn't hit it but
  // it's the cheapest defence against truncation.
  const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}
