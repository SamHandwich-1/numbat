import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertSourceRepoUsable,
  createWorktree,
} from "@/lib/feathertail/worktree";

const execFileP = promisify(execFile);

// Real-git integration tests. The cleanup mutation helpers
// (cleanupStaleWorktrees / reapStaleKillingSessions) are exercised by
// the live-DB session-status mutation tests in Slice 4's later
// checkpoint — they require a Supabase client. This file covers the
// pure-git surface (createWorktree + assertSourceRepoUsable + branch
// collision).

describe("worktree (real git)", () => {
  let tmpRoot: string;
  let sourceRepo: string;
  let worktreeRoot: string;

  beforeEach(async () => {
    // One temp tree per test holds both the throwaway source repo and
    // the worktree root, so afterEach can rm -rf the whole thing.
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "numbat-wt-test-"));
    sourceRepo = path.join(tmpRoot, "source");
    worktreeRoot = path.join(tmpRoot, "worktrees");
    await mkdir(sourceRepo);
    await mkdir(worktreeRoot);

    // Init + one commit. user.name and user.email are set locally so
    // `git commit` works regardless of the operator's global config.
    await execFileP("git", ["init", "-b", "main"], { cwd: sourceRepo });
    await execFileP("git", ["config", "user.email", "test@numbat.local"], {
      cwd: sourceRepo,
    });
    await execFileP("git", ["config", "user.name", "Numbat Test"], {
      cwd: sourceRepo,
    });
    await writeFile(path.join(sourceRepo, "README.md"), "# fixture\n", "utf8");
    await execFileP("git", ["add", "README.md"], { cwd: sourceRepo });
    await execFileP("git", ["commit", "-m", "initial"], { cwd: sourceRepo });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("createWorktree creates a worktree dir whose .git is a file (not directory)", async () => {
    const sliceName = `fixture-slice-${Math.random().toString(36).slice(2, 8)}`;
    const wt = await createWorktree({
      projectSlug: "fixture-proj",
      sliceName,
      sourceRepoPath: sourceRepo,
      worktreeRoot,
    });

    const expected = path.join(worktreeRoot, "fixture-proj", sliceName);
    expect(wt).toBe(expected);

    // Worktree directory exists.
    const wtStat = await stat(wt);
    expect(wtStat.isDirectory()).toBe(true);

    // `.git` inside a worktree is a FILE pointing at the source repo's
    // .git/worktrees/<name>/ (not a directory like a fresh clone).
    const gitStat = await stat(path.join(wt, ".git"));
    expect(gitStat.isFile()).toBe(true);

    // README.md is checked out (worktree shares the source commit).
    const readmeStat = await stat(path.join(wt, "README.md"));
    expect(readmeStat.isFile()).toBe(true);
  });

  it("createWorktree creates the expected branch name (numbat/slice/<sliceName>)", async () => {
    const sliceName = `branch-name-${Math.random().toString(36).slice(2, 8)}`;
    await createWorktree({
      projectSlug: "fixture-proj",
      sliceName,
      sourceRepoPath: sourceRepo,
      worktreeRoot,
    });

    const { stdout } = await execFileP("git", ["branch", "--list"], {
      cwd: sourceRepo,
    });
    expect(stdout).toContain(`numbat/slice/${sliceName}`);
  });

  it("createWorktree throws on branch collision", async () => {
    const sliceName = `collision-${Math.random().toString(36).slice(2, 8)}`;
    const collidingBranch = `numbat/slice/${sliceName}`;

    // Pre-create the colliding branch in the source repo.
    await execFileP("git", ["branch", collidingBranch], { cwd: sourceRepo });

    await expect(
      createWorktree({
        projectSlug: "fixture-proj",
        sliceName,
        sourceRepoPath: sourceRepo,
        worktreeRoot,
      }),
    ).rejects.toThrow();
  });

  it("assertSourceRepoUsable passes for a valid repo with HEAD", async () => {
    await expect(assertSourceRepoUsable(sourceRepo)).resolves.toBeUndefined();
  });

  it("assertSourceRepoUsable throws when the path does not exist", async () => {
    await expect(
      assertSourceRepoUsable(path.join(tmpRoot, "does-not-exist")),
    ).rejects.toThrow(/does not exist/);
  });

  it("assertSourceRepoUsable throws when the path is not a git repo", async () => {
    const plainDir = path.join(tmpRoot, "plain");
    await mkdir(plainDir);
    await expect(assertSourceRepoUsable(plainDir)).rejects.toThrow(
      /not a git repository/,
    );
  });

  it("assertSourceRepoUsable throws when the repo has no HEAD commit", async () => {
    const emptyRepo = path.join(tmpRoot, "empty");
    await mkdir(emptyRepo);
    await execFileP("git", ["init", "-b", "main"], { cwd: emptyRepo });
    await expect(assertSourceRepoUsable(emptyRepo)).rejects.toThrow(/no HEAD/);
  });
});
