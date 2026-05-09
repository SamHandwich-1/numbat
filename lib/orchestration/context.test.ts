import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/db";
import {
  ContextLoader,
  ContextLoaderCrossProjectError,
} from "@/lib/orchestration/context";

// Minimal mock that implements just `from(table).select(cols).eq(col, id).single()`,
// the only db method ContextLoader's V1 skeleton uses.
function mockClient(
  rows: Record<string, { project_id: string }>,
): SupabaseClient<Database> {
  const from = vi.fn((table: string) => ({
    select: (_cols: string) => ({
      eq: (_col: string, id: string) => ({
        single: async () => {
          const row = rows[`${table}:${id}`];
          if (!row) {
            return { data: null, error: { message: "not found" } as const };
          }
          return { data: row, error: null };
        },
      }),
    }),
  }));
  return { from } as unknown as SupabaseClient<Database>;
}

const projectA = "00000000-0000-0000-0000-0000000000a1";
const projectB = "00000000-0000-0000-0000-0000000000b1";
const sessionInB = "00000000-0000-0000-0000-000000000111";
const sessionInA = "00000000-0000-0000-0000-000000000112";
const planInB = "00000000-0000-0000-0000-000000000211";

describe("ContextLoader cross-project enforcement", () => {
  it("throws ContextLoaderCrossProjectError when a session belongs to a different project", async () => {
    const db = mockClient({ [`sessions:${sessionInB}`]: { project_id: projectB } });
    const loader = new ContextLoader(db);

    await expect(loader.buildFor(projectA, "session", sessionInB)).rejects.toBeInstanceOf(
      ContextLoaderCrossProjectError,
    );

    try {
      await loader.buildFor(projectA, "session", sessionInB);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ContextLoaderCrossProjectError);
      const err = e as ContextLoaderCrossProjectError;
      expect(err.requestedProjectId).toBe(projectA);
      expect(err.actualProjectId).toBe(projectB);
      expect(err.scope).toBe("session");
      expect(err.secondaryId).toBe(sessionInB);
      expect(err.message).toContain(projectA);
      expect(err.message).toContain(projectB);
    }
  });

  it("throws when a plan belongs to a different project", async () => {
    const db = mockClient({ [`plans:${planInB}`]: { project_id: projectB } });
    const loader = new ContextLoader(db);

    await expect(loader.buildFor(projectA, "plan", planInB)).rejects.toBeInstanceOf(
      ContextLoaderCrossProjectError,
    );
  });

  it("returns a typed SessionContext when project matches", async () => {
    const db = mockClient({ [`sessions:${sessionInA}`]: { project_id: projectA } });
    const loader = new ContextLoader(db);
    const ctx = await loader.buildFor(projectA, "session", sessionInA);
    expect(ctx.projectId).toBe(projectA);
    expect(ctx.sessionId).toBe(sessionInA);
    // V1 stub: spec / priorDebrief / skills / specs / decisions are all empty.
    expect(ctx.spec).toBeNull();
    expect(ctx.priorDebrief).toBeNull();
    expect(ctx.specs).toEqual([]);
  });

  it("returns a typed ProjectContext for the project scope (no secondary id)", async () => {
    const db = mockClient({});
    const loader = new ContextLoader(db);
    const ctx = await loader.buildFor(projectA, "project");
    expect(ctx.projectId).toBe(projectA);
    expect(ctx.claudeMd).toBeNull();
    expect(ctx.specs).toEqual([]);
  });
});
