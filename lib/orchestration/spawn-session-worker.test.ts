import { EventEmitter } from "node:events";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ─────────────────────────────────────────────────────────────────────
// Smoke test — the regression test for manual-run #1.
//
// Spawns the EXACT same shape as spawnSessionWorker (process.execPath
// + ["--import", "tsx/esm", <script.ts>, <arg>]) against a stub script
// that does at least one `@/lib/...` import. If the spawn ENOENTs (the
// original bug) or the script dies on path-alias resolution (the
// not-yet-confirmed risk in Option C), this test fails. If the stub
// runs to completion and prints "ok", the spawn shape works for real
// .ts files with project path-alias imports — i.e. the worker will
// actually start.
//
// Fixture: scripts/_smoke-aliased-import.ts (a four-line stub that
// imports one thing from @/lib/types/jsonb and prints "ok"). Lives
// under scripts/ for the same reason as other CLI entrypoints — it's
// a real .ts file that needs the project's tsconfig.json context for
// `@/` to resolve.
// ─────────────────────────────────────────────────────────────────────

const execFileP = promisify(execFile);

describe("spawn-session-worker spawn shape (smoke)", () => {
  it("Option C invocation runs a real .ts file with @/ alias imports to clean exit", async () => {
    const repoRoot = process.cwd();
    const fixture = path.join(repoRoot, "scripts", "_smoke-aliased-import.ts");

    const { stdout, stderr } = await execFileP(
      process.execPath,
      ["--import", "tsx/esm", fixture],
      { cwd: repoRoot, env: process.env },
    );

    // The fixture prints "ok" on stdout and exits 0 only if its
    // `import { WorktreeDiff } from "@/lib/types/jsonb"` resolved.
    expect(stdout.trim()).toBe("ok");
    expect(stderr).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Unit test — the spawn-error → transitionToBlocked visibility fix.
//
// Mocks child_process.spawn to return a fake child that emits 'error'
// on the next tick. Mocks transitionToBlocked. Asserts:
//   (a) spawnSessionWorker returns synchronously (fire-and-forget)
//   (b) transitionToBlocked was called with source: 'worker' and a
//       message containing the spawn error text
//
// The unit test lives in this same file so the smoke test (real
// spawn) and the mocked-spawn unit test can share their import
// stanza — the only difference is which dependencies are mocked.
// Because vi.mock is hoisted to module top, the unit-test mocks are
// in scope for the whole file; the smoke test does NOT use the
// mocked spawn (it uses execFile, a different child_process export
// that's not mocked here). This is a deliberate boundary — execFile
// and spawn are separate; mocking only spawn lets the smoke test
// hit the real one.
// ─────────────────────────────────────────────────────────────────────

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

vi.mock("@/lib/supabase/mutations/session-status", () => ({
  transitionToBlocked: vi.fn(),
}));

// Suppress the intentional console.error from handleSpawnError —
// the test asserts on the DB-write side, not on stderr noise.
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe("spawnSessionWorker — spawn-error → transitionToBlocked", () => {
  it("transitions the session to blocked with source='worker' when spawn errors", async () => {
    const { spawnSessionWorker } = await import(
      "@/lib/orchestration/spawn-session-worker"
    );
    const { transitionToBlocked } = await import(
      "@/lib/supabase/mutations/session-status"
    );

    // Build a fake ChildProcess that emits 'error' on the next tick.
    // EventEmitter is the minimal shape `worker.once('error', fn)` and
    // `worker.unref()` need.
    const fakeChild = new EventEmitter() as EventEmitter & { unref: () => void };
    fakeChild.unref = vi.fn();

    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(fakeChild);

    const sessionId = "fixture-session-id";
    spawnSessionWorker(sessionId);

    // spawnSessionWorker must have returned synchronously and called
    // .unref() — the route handler depends on this for fire-and-forget.
    expect(fakeChild.unref).toHaveBeenCalledTimes(1);
    expect(transitionToBlocked).not.toHaveBeenCalled(); // not yet — emit pending

    // Emit the spawn error. handleSpawnError runs async; await a
    // microtask flush so the await inside it lands.
    const spawnError = new Error("spawn pnpm ENOENT");
    fakeChild.emit("error", spawnError);
    await new Promise((r) => setImmediate(r));

    expect(transitionToBlocked).toHaveBeenCalledTimes(1);
    const [dbArg, sessionArg, payload] = (
      transitionToBlocked as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [
      unknown,
      string,
      { last_error: { message: string; source: string; occurred_at: string } },
    ];
    void dbArg; // sbAdmin — not asserting on the client instance
    expect(sessionArg).toBe(sessionId);
    expect(payload.last_error.source).toBe("worker");
    expect(payload.last_error.message).toContain("spawn pnpm ENOENT");
    // occurred_at is an ISO timestamp set inside handleSpawnError;
    // assert it parses, not its exact value.
    expect(Number.isNaN(Date.parse(payload.last_error.occurred_at))).toBe(
      false,
    );

    // console.error was also called — secondary visibility signal.
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("swallows DB-write failure but still logs both errors to console", async () => {
    const { spawnSessionWorker } = await import(
      "@/lib/orchestration/spawn-session-worker"
    );
    const { transitionToBlocked } = await import(
      "@/lib/supabase/mutations/session-status"
    );

    const fakeChild = new EventEmitter() as EventEmitter & { unref: () => void };
    fakeChild.unref = vi.fn();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(fakeChild);

    // Both side-effects fail. The function must not throw.
    (transitionToBlocked as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("db connection refused"),
    );

    spawnSessionWorker("another-id");
    fakeChild.emit("error", new Error("spawn ENOENT"));
    await new Promise((r) => setImmediate(r));

    expect(transitionToBlocked).toHaveBeenCalledTimes(1);
    // Two console.error calls expected: the spawn-failure log AND the
    // DB-write-failure log. Both signals preserved.
    expect(consoleErrorSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
