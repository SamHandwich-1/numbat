import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Debrief, Decision, Skill, Spec } from "@/lib/types/db";
import {
  ContextLoader,
  ContextLoaderCrossProjectError,
} from "@/lib/orchestration/context";

// ───────────────────────────────────────────────────────────────────────
// Mock Supabase client
//
// Backs the ContextLoader's query shapes with in-memory fixtures. Each
// table accepts a row array; the mock applies eq/order/limit semantics
// faithfully so tests can assert on real behaviour (filtering, ordering,
// capping) rather than on shape alone.
//
// Supported chains (the set ContextLoader uses as of sub-slice 6a):
//
//   from('projects') .select('claude_md').eq('id', X).single()
//   from('sessions') .select('project_id, spec_id').eq('id', X).single()
//   from('plans')    .select('project_id').eq('id', X).single()
//   from('decisions').select('*').eq('project_id', X)
//     .order('created_at', { ascending: false }).limit(30)
//   from('specs')    .select('*').eq('project_id', X)
//   from('specs')    .select('*').eq('id', X).maybeSingle()
//   from('debriefs') .select('*').eq('session_id', X)
//     .order('created_at', { ascending: false }).limit(1).maybeSingle()
//   from('skills')   .select('*').eq('project_id', X)
//     .order('usage_count', { ascending: false }).order('name')
//
// The chain is uniform — `.then` is wired on every node so awaiting any
// shape returns `{ data, error }`. `.single()` / `.maybeSingle()` apply
// the terminal selection.
// ───────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Order = [string, { ascending: boolean }];
type QueryState = {
  filters: Array<[string, unknown]>;
  orders: Order[];
  limit?: number;
};

function evaluate(rows: Row[], state: QueryState): Row[] {
  let result = rows;
  for (const [col, val] of state.filters) {
    result = result.filter((r) => r[col] === val);
  }
  if (state.orders.length > 0) {
    result = [...result].sort((a, b) => {
      for (const [col, { ascending }] of state.orders) {
        const av = a[col] as string | number;
        const bv = b[col] as string | number;
        if (av < bv) return ascending ? -1 : 1;
        if (av > bv) return ascending ? 1 : -1;
      }
      return 0;
    });
  }
  if (state.limit !== undefined) result = result.slice(0, state.limit);
  return result;
}

type Chain = {
  eq: (col: string, val: unknown) => Chain;
  order: (col: string, opts?: { ascending?: boolean }) => Chain;
  limit: (n: number) => Chain;
  single: () => Promise<{ data: Row | null; error: { message: string } | null }>;
  maybeSingle: () => Promise<{ data: Row | null; error: null }>;
  then: <T>(
    onFulfilled: (v: { data: Row[]; error: null }) => T,
  ) => Promise<T>;
};

function builder(rows: Row[], state: QueryState): Chain {
  const chain: Chain = {
    eq: (col, val) =>
      builder(rows, { ...state, filters: [...state.filters, [col, val]] }),
    order: (col, opts) =>
      builder(rows, {
        ...state,
        orders: [
          ...state.orders,
          [col, { ascending: opts?.ascending ?? true }],
        ],
      }),
    limit: (n) => builder(rows, { ...state, limit: n }),
    single: async () => {
      const result = evaluate(rows, state);
      if (result.length === 0) {
        return { data: null, error: { message: "not found" } };
      }
      return { data: result[0] ?? null, error: null };
    },
    maybeSingle: async () => {
      const result = evaluate(rows, state);
      return { data: result[0] ?? null, error: null };
    },
    then: (onFulfilled) =>
      Promise.resolve({
        data: evaluate(rows, state),
        error: null as null,
      }).then(onFulfilled),
  };
  return chain;
}

function mockClient(
  opts: {
    projects?: Row[];
    sessions?: Row[];
    plans?: Row[];
    specs?: Row[];
    decisions?: Row[];
    skills?: Skill[];
    debriefs?: Row[];
  } = {},
): SupabaseClient<Database> {
  const tableRows: Record<string, Row[]> = {
    projects: opts.projects ?? [],
    sessions: opts.sessions ?? [],
    plans: opts.plans ?? [],
    specs: opts.specs ?? [],
    decisions: opts.decisions ?? [],
    skills: (opts.skills ?? []) as Row[],
    debriefs: opts.debriefs ?? [],
  };
  const from = vi.fn((table: string) => ({
    select: (_cols?: string) =>
      builder(tableRows[table] ?? [], { filters: [], orders: [] }),
  }));
  return { from } as unknown as SupabaseClient<Database>;
}

// ───────────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────────

const projectA = "00000000-0000-0000-0000-0000000000a1";
const projectB = "00000000-0000-0000-0000-0000000000b1";
const sessionInB = "00000000-0000-0000-0000-000000000111";
const sessionInA = "00000000-0000-0000-0000-000000000112";
const planInB = "00000000-0000-0000-0000-000000000211";
const specInA = "00000000-0000-0000-0000-000000000401";
const specInB = "00000000-0000-0000-0000-000000000402";
const specOtherInA = "00000000-0000-0000-0000-000000000403";

const skillInA: Skill = {
  id: "00000000-0000-0000-0000-000000000301",
  project_id: projectA,
  name: "Fix typo",
  description: null,
  prompt_template: "Fix the typo in the line below.",
  usage_count: 0,
  created_at: "2026-05-14T00:00:00Z",
  updated_at: "2026-05-14T00:00:00Z",
};
const skillInB: Skill = {
  ...skillInA,
  id: "00000000-0000-0000-0000-000000000302",
  project_id: projectB,
  name: "Rename clearly",
};

// ───────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────

describe("ContextLoader cross-project enforcement", () => {
  it("throws ContextLoaderCrossProjectError when a session belongs to a different project", async () => {
    // Decoy fixtures for every table — a leak past the assertion would
    // surface as wrong/extra data in the rejected promise rather than
    // silently doing nothing. Skills from BOTH projects in the pool so
    // an accidental sneak-past of the cross-project gate would mix them.
    const db = mockClient({
      sessions: [{ id: sessionInB, project_id: projectB, spec_id: null }],
      projects: [{ id: projectA, claude_md: "A md" }],
      specs: [{ id: specInA, project_id: projectA, goal: "A goal" }],
      decisions: [
        {
          id: "d1",
          project_id: projectA,
          type: "approve",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
      debriefs: [
        {
          id: "df1",
          session_id: sessionInA,
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
      skills: [skillInA, skillInB],
    });
    const loader = new ContextLoader(db);

    await expect(
      loader.buildFor(projectA, "session", sessionInB),
    ).rejects.toBeInstanceOf(ContextLoaderCrossProjectError);

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
    const db = mockClient({
      plans: [{ id: planInB, project_id: projectB }],
    });
    const loader = new ContextLoader(db);

    await expect(
      loader.buildFor(projectA, "plan", planInB),
    ).rejects.toBeInstanceOf(ContextLoaderCrossProjectError);
  });

  it("returns a SessionContext with all six fields populated when project matches", async () => {
    const claudeMd = "# Project A\n\nFixture content.";
    const sessionSpec = {
      id: specInA,
      project_id: projectA,
      plan_id: null,
      goal: "the session's spec",
      out_of_scope: null,
      files_affected: null,
      acceptance_criteria: null,
      open_questions: null,
      version: 1,
      created_at: "2026-05-20T00:00:00Z",
    };
    const otherProjectASpec = {
      ...sessionSpec,
      id: specOtherInA,
      goal: "another spec",
    };
    const otherProjectSpec = {
      ...sessionSpec,
      id: specInB,
      project_id: projectB,
      goal: "B spec",
    };
    const decisionA1 = {
      id: "dec-1",
      project_id: projectA,
      session_id: null,
      plan_id: null,
      type: "approve",
      context: null,
      payload: null,
      created_at: "2026-05-10T00:00:00Z",
    };
    const decisionA2 = {
      ...decisionA1,
      id: "dec-2",
      created_at: "2026-05-11T00:00:00Z",
    };
    const decisionB1 = {
      ...decisionA1,
      id: "dec-b",
      project_id: projectB,
      created_at: "2026-05-12T00:00:00Z",
    };
    const priorDebrief = {
      id: "df-1",
      project_id: projectA,
      session_id: sessionInA,
      plan_stage_id: null,
      debrief_type: "direct",
      content: {
        what_we_did: "x",
        where_this_fits: "y",
        why_it_matters: "z",
        what_went_wrong_or_next: "w",
      },
      llm_call_id: null,
      prompt_version: "v1",
      duration_ms: null,
      created_at: "2026-05-25T10:00:00Z",
    };

    const db = mockClient({
      sessions: [{ id: sessionInA, project_id: projectA, spec_id: specInA }],
      projects: [{ id: projectA, claude_md: claudeMd }],
      specs: [sessionSpec, otherProjectASpec, otherProjectSpec],
      // Intentionally unordered — the loader's `order(... desc)` must sort.
      decisions: [decisionA2, decisionA1, decisionB1],
      debriefs: [priorDebrief],
      skills: [skillInA, skillInB],
    });
    const loader = new ContextLoader(db);
    const ctx = await loader.buildFor(projectA, "session", sessionInA);

    expect(ctx.projectId).toBe(projectA);
    expect(ctx.sessionId).toBe(sessionInA);

    // Project-level fields populated, cross-project filtering applied.
    expect(ctx.claudeMd).toBe(claudeMd);
    expect(ctx.specs).toHaveLength(2);
    expect(ctx.specs.every((s: Spec) => s.project_id === projectA)).toBe(true);
    expect(ctx.recentDecisions).toHaveLength(2);
    expect(
      ctx.recentDecisions.every((d: Decision) => d.project_id === projectA),
    ).toBe(true);
    // Decisions ordered by created_at desc.
    expect(ctx.recentDecisions[0]?.id).toBe("dec-2");
    expect(ctx.recentDecisions[1]?.id).toBe("dec-1");

    // Skills only populated for project A.
    expect(ctx.skills).toHaveLength(1);
    expect(ctx.skills[0]?.project_id).toBe(projectA);
    expect(ctx.skills[0]?.name).toBe("Fix typo");

    // Session-only fields populated.
    expect(ctx.spec).not.toBeNull();
    expect(ctx.spec?.id).toBe(specInA);
    expect(ctx.priorDebrief).not.toBeNull();
    expect((ctx.priorDebrief as Debrief).id).toBe("df-1");
  });

  it("returns a typed ProjectContext for the project scope (no secondary id)", async () => {
    const db = mockClient({
      projects: [{ id: projectA, claude_md: "project A md" }],
      specs: [{ id: specInA, project_id: projectA, goal: "A spec" }],
      decisions: [
        {
          id: "d1",
          project_id: projectA,
          type: "approve",
          created_at: "2026-05-10T00:00:00Z",
        },
      ],
    });
    const loader = new ContextLoader(db);
    const ctx = await loader.buildFor(projectA, "project");

    expect(ctx.projectId).toBe(projectA);
    // §3.5 symmetry: project scope fills the three project-level fields.
    expect(ctx.claudeMd).toBe("project A md");
    expect(ctx.specs).toHaveLength(1);
    expect(ctx.recentDecisions).toHaveLength(1);
    // Skills stays session-scope-only (Slice 3 convention).
    expect(ctx.skills).toEqual([]);
  });

  it("loadAndAssertSession threads spec_id correctly to ctx.spec", async () => {
    // Case 1: spec_id null → ctx.spec is null even when project has specs.
    // The project-level specs query still runs (proves the spec=null
    // branch only skips loadSpec, not loadSpecs).
    const dbNullSpec = mockClient({
      sessions: [{ id: sessionInA, project_id: projectA, spec_id: null }],
      projects: [{ id: projectA, claude_md: "md" }],
      specs: [
        { id: specInA, project_id: projectA, goal: "exists but not linked" },
      ],
    });
    const ctxNull = await new ContextLoader(dbNullSpec).buildFor(
      projectA,
      "session",
      sessionInA,
    );
    expect(ctxNull.spec).toBeNull();
    expect(ctxNull.specs).toHaveLength(1);

    // Case 2: spec_id set → ctx.spec resolves to the linked spec by id,
    // not just any spec in the project.
    const dbWithSpec = mockClient({
      sessions: [{ id: sessionInA, project_id: projectA, spec_id: specInA }],
      projects: [{ id: projectA, claude_md: "md" }],
      specs: [
        { id: specInA, project_id: projectA, goal: "linked spec" },
        { id: specOtherInA, project_id: projectA, goal: "other" },
      ],
    });
    const ctxWith = await new ContextLoader(dbWithSpec).buildFor(
      projectA,
      "session",
      sessionInA,
    );
    expect(ctxWith.spec).not.toBeNull();
    expect(ctxWith.spec?.id).toBe(specInA);
    expect(ctxWith.spec?.goal).toBe("linked spec");
  });

  it("priorDebrief returns the most recent debrief by created_at", async () => {
    const olderDebrief = {
      id: "df-old",
      project_id: projectA,
      session_id: sessionInA,
      plan_stage_id: null,
      debrief_type: "direct",
      content: {
        what_we_did: "old",
        where_this_fits: "",
        why_it_matters: "",
        what_went_wrong_or_next: "",
      },
      llm_call_id: null,
      prompt_version: "v1",
      duration_ms: null,
      created_at: "2026-05-01T00:00:00Z",
    };
    const newerDebrief = {
      ...olderDebrief,
      id: "df-new",
      created_at: "2026-05-25T12:00:00Z",
    };
    const db = mockClient({
      sessions: [{ id: sessionInA, project_id: projectA, spec_id: null }],
      projects: [{ id: projectA, claude_md: null }],
      // Insertion order oldest-first — the mock's order(desc) must
      // reorder so df-new is returned.
      debriefs: [olderDebrief, newerDebrief],
    });
    const ctx = await new ContextLoader(db).buildFor(
      projectA,
      "session",
      sessionInA,
    );
    expect(ctx.priorDebrief).not.toBeNull();
    expect(ctx.priorDebrief?.id).toBe("df-new");
  });

  it("does not fan out parallel loads when the cross-project assertion fails", async () => {
    // Full decoy fixtures across every table. If the parallel load ran
    // in spite of the throw, db.from would be called with each of these
    // table names. The assertion below proves only 'sessions' was hit.
    const db = mockClient({
      sessions: [{ id: sessionInB, project_id: projectB, spec_id: null }],
      projects: [{ id: projectA, claude_md: "A md" }],
      specs: [{ id: specInA, project_id: projectA, goal: "A goal" }],
      decisions: [
        {
          id: "d1",
          project_id: projectA,
          type: "approve",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
      debriefs: [
        {
          id: "df1",
          session_id: sessionInA,
          created_at: "2026-05-25T00:00:00Z",
        },
      ],
      skills: [skillInA],
    });
    // Cast the spy out of the typed client to read .mock.calls.
    const fromSpy = (db as unknown as { from: ReturnType<typeof vi.fn> })
      .from;
    const loader = new ContextLoader(db);

    await expect(
      loader.buildFor(projectA, "session", sessionInB),
    ).rejects.toBeInstanceOf(ContextLoaderCrossProjectError);

    const tablesQueried = fromSpy.mock.calls.map((c) => c[0] as string);
    expect(tablesQueried).toEqual(["sessions"]);
  });

  it("specs are returned in deterministic created_at desc order regardless of physical insertion order", async () => {
    // The cache-stable prefix in lib/llm/prompts/opus-debrief.ts renders
    // specs as a list — identical project state must produce identical
    // prefix bytes across calls so Anthropic's 5-min-TTL prompt cache
    // hits. Without an ORDER BY on loadSpecs, Postgres makes no row-
    // order guarantee — two calls can return the same rows in different
    // physical orders and the cache misses on every call.
    //
    // Two seeded mock clients with the same logical content but
    // different physical row orders simulate that variance. A faithful
    // loader (post-fix) canonicalises both to the same sequence; the
    // unfixed loader (no ORDER BY) returns physical order, so the two
    // builds produce different specs arrays and the first assertion
    // below fails.
    const specOld: Spec = {
      id: "00000000-0000-0000-0000-0000000003a1",
      project_id: projectA,
      plan_id: null,
      goal: "oldest spec",
      out_of_scope: null,
      files_affected: null,
      acceptance_criteria: null,
      open_questions: null,
      version: 1,
      created_at: "2026-05-10T00:00:00Z",
    };
    const specMid: Spec = {
      ...specOld,
      id: "00000000-0000-0000-0000-0000000003a2",
      goal: "middle spec",
      created_at: "2026-05-15T00:00:00Z",
    };
    const specNew: Spec = {
      ...specOld,
      id: "00000000-0000-0000-0000-0000000003a3",
      goal: "newest spec",
      created_at: "2026-05-20T00:00:00Z",
    };

    // Seed 1: middle, old, new — no chronology.
    const db1 = mockClient({
      sessions: [{ id: sessionInA, project_id: projectA, spec_id: null }],
      projects: [{ id: projectA, claude_md: null }],
      specs: [specMid, specOld, specNew],
    });
    // Seed 2: new, mid, old — different physical order, same logical content.
    const db2 = mockClient({
      sessions: [{ id: sessionInA, project_id: projectA, spec_id: null }],
      projects: [{ id: projectA, claude_md: null }],
      specs: [specNew, specMid, specOld],
    });

    const ctx1 = await new ContextLoader(db1).buildFor(
      projectA,
      "session",
      sessionInA,
    );
    const ctx2 = await new ContextLoader(db2).buildFor(
      projectA,
      "session",
      sessionInA,
    );

    // (1) Determinism across physical layouts — the cache-stability
    // property. Pre-fix returns physical order (different between db1
    // and db2) and this fails.
    const ids1 = ctx1.specs.map((s: Spec) => s.id);
    const ids2 = ctx2.specs.map((s: Spec) => s.id);
    expect(ids1).toEqual(ids2);

    // (2) Canonical order is created_at desc — newest first. Locks the
    // chosen ordering semantic so a future "simplify" pass can't switch
    // to created_at asc without breaking this test.
    expect(ids1).toEqual([specNew.id, specMid.id, specOld.id]);
  });

  it("caps recentDecisions at 30 rows ordered desc by created_at", async () => {
    // 35 decisions for project A with sequential created_at — the
    // loader's limit(30) must drop the five oldest and the order must
    // be desc. Padded zero-second values so lexical compare matches
    // chronological.
    const decisions: Row[] = [];
    for (let i = 0; i < 35; i++) {
      decisions.push({
        id: `dec-${i.toString().padStart(2, "0")}`,
        project_id: projectA,
        session_id: null,
        plan_id: null,
        type: "approve",
        context: null,
        payload: null,
        created_at: `2026-05-01T00:00:${i.toString().padStart(2, "0")}.000Z`,
      });
    }
    // Decoy from project B at a LATER time than all project A rows.
    // If the project filter failed, this would land at position 0.
    decisions.push({
      id: "dec-b",
      project_id: projectB,
      session_id: null,
      plan_id: null,
      type: "approve",
      context: null,
      payload: null,
      created_at: "2026-05-02T00:00:00.000Z",
    });

    const db = mockClient({
      sessions: [{ id: sessionInA, project_id: projectA, spec_id: null }],
      projects: [{ id: projectA, claude_md: null }],
      decisions,
    });
    const ctx = await new ContextLoader(db).buildFor(
      projectA,
      "session",
      sessionInA,
    );

    expect(ctx.recentDecisions).toHaveLength(30);
    // Newest first: dec-34, dec-33, ... dec-05 at position 29 (the
    // 30th-newest project-A row).
    expect(ctx.recentDecisions[0]?.id).toBe("dec-34");
    expect(ctx.recentDecisions[29]?.id).toBe("dec-05");
    // Project filter still applied — decoy excluded.
    expect(
      ctx.recentDecisions.every((d: Decision) => d.project_id === projectA),
    ).toBe(true);
  });
});
