import { describe, expect, it } from "vitest";

import { parseDiff } from "@/lib/feathertail/diff";

// Pure-parser tests for the worktree diff capture pipeline. Canned
// `git status --porcelain` / `git diff` / `git diff --numstat` strings
// → assert the parsed WorktreeDiff matches the expected shape. No
// real git invocation, no DB.

describe("parseDiff", () => {
  it("single modified file (with hunks in --diff)", () => {
    const porcelain = " M src/foo.ts\n";
    const numstat = "6\t6\tsrc/foo.ts\n";
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index abc123..def456 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,6 +1,6 @@",
      "-old line 1",
      "+new line 1",
      "-old line 2",
      "+new line 2",
      "",
    ].join("\n");

    const result = parseDiff({
      porcelain,
      diff,
      numstat,
      untrackedLineCounts: {},
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      path: "src/foo.ts",
      status: "modified",
      additions: 6,
      deletions: 6,
    });
    expect(result.files[0]?.patch).toContain("diff --git a/src/foo.ts");
    expect(result.totals).toEqual({
      files_changed: 1,
      additions: 6,
      deletions: 6,
    });
  });

  it("single added (untracked) file — additions from untrackedLineCounts, no patch", () => {
    const porcelain = "?? src/new.ts\n";
    const result = parseDiff({
      porcelain,
      diff: "",
      numstat: "",
      untrackedLineCounts: { "src/new.ts": 24 },
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toEqual({
      path: "src/new.ts",
      status: "added",
      additions: 24,
      deletions: 0,
      patch: null,
    });
    expect(result.totals).toEqual({
      files_changed: 1,
      additions: 24,
      deletions: 0,
    });
  });

  it("single deleted file — status='deleted', deletions from numstat", () => {
    const porcelain = " D src/gone.ts\n";
    const numstat = "0\t14\tsrc/gone.ts\n";
    const diff = [
      "diff --git a/src/gone.ts b/src/gone.ts",
      "deleted file mode 100644",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1,14 +0,0 @@",
      "",
    ].join("\n");

    const result = parseDiff({
      porcelain,
      diff,
      numstat,
      untrackedLineCounts: {},
    });

    expect(result.files[0]).toMatchObject({
      path: "src/gone.ts",
      status: "deleted",
      additions: 0,
      deletions: 14,
    });
    expect(result.files[0]?.patch).toContain("deleted file mode");
  });

  it("binary file in --numstat (dashes) — counts default to 0", () => {
    const porcelain = " M assets/logo.png\n";
    const numstat = "-\t-\tassets/logo.png\n";
    const diff =
      "diff --git a/assets/logo.png b/assets/logo.png\n" +
      "Binary files a/assets/logo.png and b/assets/logo.png differ\n";

    const result = parseDiff({
      porcelain,
      diff,
      numstat,
      untrackedLineCounts: {},
    });

    expect(result.files[0]).toMatchObject({
      path: "assets/logo.png",
      status: "modified",
      additions: 0,
      deletions: 0,
    });
    expect(result.totals).toEqual({
      files_changed: 1,
      additions: 0,
      deletions: 0,
    });
  });

  it("empty diff — no files, totals all zero", () => {
    const result = parseDiff({
      porcelain: "",
      diff: "",
      numstat: "",
      untrackedLineCounts: {},
    });

    expect(result.files).toEqual([]);
    expect(result.totals).toEqual({
      files_changed: 0,
      additions: 0,
      deletions: 0,
    });
  });

  it("mixed: two modified + one added + one deleted", () => {
    const porcelain = [
      " M src/foo.ts",
      " M src/bar.ts",
      "?? src/new.ts",
      " D src/gone.ts",
      "",
    ].join("\n");

    const numstat = [
      "3\t2\tsrc/foo.ts",
      "5\t0\tsrc/bar.ts",
      "0\t10\tsrc/gone.ts",
      "",
    ].join("\n");

    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "@@ -1,3 +1,3 @@",
      "-a",
      "+b",
      "",
      "diff --git a/src/bar.ts b/src/bar.ts",
      "@@ -1,0 +1,5 @@",
      "+x",
      "",
      "diff --git a/src/gone.ts b/src/gone.ts",
      "deleted file mode 100644",
      "",
    ].join("\n");

    const result = parseDiff({
      porcelain,
      diff,
      numstat,
      untrackedLineCounts: { "src/new.ts": 7 },
    });

    expect(result.files).toHaveLength(4);
    const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]));
    expect(byPath["src/foo.ts"]).toMatchObject({
      status: "modified",
      additions: 3,
      deletions: 2,
    });
    expect(byPath["src/bar.ts"]).toMatchObject({
      status: "modified",
      additions: 5,
      deletions: 0,
    });
    expect(byPath["src/new.ts"]).toMatchObject({
      status: "added",
      additions: 7,
      deletions: 0,
      patch: null,
    });
    expect(byPath["src/gone.ts"]).toMatchObject({
      status: "deleted",
      additions: 0,
      deletions: 10,
    });
    expect(result.totals).toEqual({
      files_changed: 4,
      additions: 15,
      deletions: 12,
    });
  });

  it("MM (staged-then-restaged) treated as modified", () => {
    // Edge case the worker shouldn't actually produce (SDK doesn't stage
    // unstaged-but-the parser stays robust if it ever sees `MM`).
    const porcelain = "MM src/foo.ts\n";
    const numstat = "1\t1\tsrc/foo.ts\n";
    const result = parseDiff({
      porcelain,
      diff: "",
      numstat,
      untrackedLineCounts: {},
    });
    expect(result.files[0]).toMatchObject({
      path: "src/foo.ts",
      status: "modified",
    });
  });

  it("untracked line count missing in map defaults to 0 (silent fallback)", () => {
    const porcelain = "?? src/orphan.ts\n";
    const result = parseDiff({
      porcelain,
      diff: "",
      numstat: "",
      untrackedLineCounts: {},
    });
    expect(result.files[0]).toMatchObject({
      path: "src/orphan.ts",
      status: "added",
      additions: 0,
      deletions: 0,
    });
  });
});
