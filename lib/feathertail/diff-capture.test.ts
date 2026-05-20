import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureDiff } from "@/lib/feathertail/diff";

// Real-git integration tests for captureDiff. These tests exercise the
// pieces parseDiff can't reach on its own:
//   - the `git status --porcelain -uall` invocation (Defect 1 from
//     manual-run #1: without -uall, untracked directories collapse to
//     a single dir entry and per-file line counts are 0)
//   - the binary-file detection in captureDiff's untracked-file read
//     loop (introduced alongside -uall; with the flag, captureDiff now
//     reads every nested untracked file including binaries the agent
//     might create — we must not line-count raw bytes)
//   - the Defect 2 invariant: a file SIBLING to the worktree (e.g.
//     `<sliceName>.log` per workerLogPathFor) is invisible to git and
//     does NOT appear in the captured diff
//
// The "would have caught run #1" test is the final case below — it
// reproduces the exact bug pattern (untracked nested dirs + sibling
// log) and asserts the post-fix shape.

const execFileP = promisify(execFile);

describe("captureDiff (real git)", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "numbat-diff-cap-test-"));
    await execFileP("git", ["init", "-b", "main"], { cwd: tmpRoot });
    await execFileP("git", ["config", "user.email", "test@numbat.local"], {
      cwd: tmpRoot,
    });
    await execFileP("git", ["config", "user.name", "Test"], { cwd: tmpRoot });
    await writeFile(path.join(tmpRoot, "README.md"), "# fixture\n", "utf8");
    await execFileP("git", ["add", "README.md"], { cwd: tmpRoot });
    await execFileP("git", ["commit", "-m", "initial"], { cwd: tmpRoot });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    // Cleanup any sibling log fixture from the last test.
    const siblingLog = path.join(
      path.dirname(tmpRoot),
      `${path.basename(tmpRoot)}.log`,
    );
    await rm(siblingLog, { force: true });
  });

  it("expands untracked nested directories (-uall) and counts lines per file", async () => {
    await mkdir(path.join(tmpRoot, "src", "feature"), { recursive: true });
    await writeFile(
      path.join(tmpRoot, "src", "feature", "one.ts"),
      "line1\nline2\nline3\n",
      "utf8",
    );
    await writeFile(
      path.join(tmpRoot, "src", "feature", "two.ts"),
      "alpha\nbeta\n",
      "utf8",
    );
    await writeFile(
      path.join(tmpRoot, "src", "feature", "three.ts"),
      "only one line (no trailing newline)",
      "utf8",
    );

    const diff = await captureDiff(tmpRoot);

    // Three FILES, not one collapsed directory entry.
    expect(diff.files).toHaveLength(3);
    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]));
    expect(byPath["src/feature/one.ts"]).toMatchObject({
      status: "added",
      additions: 3,
      deletions: 0,
    });
    expect(byPath["src/feature/two.ts"]).toMatchObject({
      status: "added",
      additions: 2,
      deletions: 0,
    });
    // No trailing newline → counts the final line as +1.
    expect(byPath["src/feature/three.ts"]).toMatchObject({
      status: "added",
      additions: 1,
      deletions: 0,
    });
    expect(diff.totals).toEqual({
      files_changed: 3,
      additions: 6,
      deletions: 0,
    });
  });

  it("treats an untracked binary file (with embedded null byte) as 0/0", async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x7f, 0x80]);
    await writeFile(path.join(tmpRoot, "blob.bin"), binary);

    const diff = await captureDiff(tmpRoot);
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]).toMatchObject({
      path: "blob.bin",
      status: "added",
      additions: 0,
      deletions: 0,
      patch: null,
    });
  });

  it("treats an untracked binary in a NESTED directory as 0/0 (-uall + binary detection)", async () => {
    await mkdir(path.join(tmpRoot, "assets", "icons"), { recursive: true });
    // PNG-like header — real binary, contains the null bytes the
    // heuristic checks for in the first 8 KB.
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    await writeFile(path.join(tmpRoot, "assets", "icons", "logo.png"), png);

    const diff = await captureDiff(tmpRoot);
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]).toMatchObject({
      path: "assets/icons/logo.png",
      additions: 0,
      deletions: 0,
    });
  });

  it("a file SIBLING to the worktree is invisible to captureDiff (Defect 2 invariant)", async () => {
    // Simulate the post-fix log placement: <worktreePath>.log
    const siblingLog = path.join(
      path.dirname(tmpRoot),
      `${path.basename(tmpRoot)}.log`,
    );
    await writeFile(
      siblingLog,
      "worker log line 1\nworker log line 2\nworker log line 3\n",
      "utf8",
    );
    // Real work inside the worktree.
    await writeFile(path.join(tmpRoot, "real-edit.ts"), "code\n", "utf8");

    const diff = await captureDiff(tmpRoot);
    const paths = diff.files.map((f) => f.path);

    // Real work is present.
    expect(paths).toContain("real-edit.ts");
    // The sibling log does NOT appear — git never saw it.
    expect(paths.some((p) => p.endsWith(".log"))).toBe(false);
  });

  it("would-have-caught-run-#1 repro: 5 nested text files + 1 binary + sibling log → 6 entries, real line counts, no log", async () => {
    // Mirrors the exact shape of manual-run #1's bug pattern, with
    // the log SIBLING to the worktree (post-fix design).
    await mkdir(path.join(tmpRoot, "lib", "feature"), { recursive: true });
    await mkdir(path.join(tmpRoot, "app", "page", "[id]"), { recursive: true });

    // Five text files with known line counts.
    const make = (n: number) => Array(n).fill("line").join("\n") + "\n";
    await writeFile(
      path.join(tmpRoot, "lib", "feature", "main.ts"),
      make(37),
      "utf8",
    );
    await writeFile(
      path.join(tmpRoot, "lib", "feature", "main.test.ts"),
      make(133),
      "utf8",
    );
    await writeFile(
      path.join(tmpRoot, "lib", "feature", "types.ts"),
      make(193),
      "utf8",
    );
    await writeFile(
      path.join(tmpRoot, "app", "page", "a.tsx"),
      make(129),
      "utf8",
    );
    await writeFile(
      path.join(tmpRoot, "app", "page", "[id]", "b.tsx"),
      make(400),
      "utf8",
    );
    // One binary file (the agent might emit a generated artifact).
    await writeFile(
      path.join(tmpRoot, "lib", "feature", "compiled.bin"),
      Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]),
    );
    // Sibling log — outside the worktree.
    const siblingLog = path.join(
      path.dirname(tmpRoot),
      `${path.basename(tmpRoot)}.log`,
    );
    await writeFile(siblingLog, "log\nlog\nlog\n", "utf8");

    const diff = await captureDiff(tmpRoot);
    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]));

    // All five text files present with their real line counts.
    expect(byPath["lib/feature/main.ts"]).toMatchObject({ additions: 37 });
    expect(byPath["lib/feature/main.test.ts"]).toMatchObject({ additions: 133 });
    expect(byPath["lib/feature/types.ts"]).toMatchObject({ additions: 193 });
    expect(byPath["app/page/a.tsx"]).toMatchObject({ additions: 129 });
    expect(byPath["app/page/[id]/b.tsx"]).toMatchObject({ additions: 400 });

    // Binary file is 0/0.
    expect(byPath["lib/feature/compiled.bin"]).toMatchObject({
      additions: 0,
      deletions: 0,
    });

    // Six untracked entries total. No log file in the captured diff.
    expect(diff.files).toHaveLength(6);
    expect(diff.files.some((f) => f.path.endsWith(".log"))).toBe(false);

    // Totals reflect only the text files (binary contributes 0).
    expect(diff.totals.files_changed).toBe(6);
    expect(diff.totals.additions).toBe(37 + 133 + 193 + 129 + 400); // 892
    expect(diff.totals.deletions).toBe(0);
  });
});
