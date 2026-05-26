import type { SupabaseClient } from "@supabase/supabase-js";
import { listSkillsForProject } from "@/lib/supabase/queries/skills";
import type { Database, Debrief, Decision, Skill, Spec } from "@/lib/types/db";

// ───────────────────────────────────────────────────────────────────────
// Scopes
// ───────────────────────────────────────────────────────────────────────

export type ContextScope = "project" | "session" | "plan";

// Slice 6 sub-slice 6a fills the project- and session-scope stubs with
// real data: `claudeMd` reads from `projects.claude_md`, `recentDecisions`
// is the project's last 30 by `created_at desc`, `specs` is all project
// specs, `spec` joins via `sessions.spec_id`, `priorDebrief` is the latest
// debriefs row for the session. `skills` was already populated in Slice 3
// for session scope. `PlanContext` keeps its stubs until Slice 7 fills the
// brief / dialectic state.
export type ProjectContext = {
  projectId: string;
  claudeMd: string | null;
  specs: readonly Spec[];
  skills: readonly Skill[];
  recentDecisions: readonly Decision[];
};

export type SessionContext = ProjectContext & {
  sessionId: string;
  spec: Spec | null;
  priorDebrief: Debrief | null;
};

export type PlanContext = ProjectContext & {
  planId: string;
  brief: null;
  dialecticState: readonly never[];
};

// ───────────────────────────────────────────────────────────────────────
// Cross-project read = a programming error in the caller. Throw — caller
// has a bug, not an expected failure (per CLAUDE.md error rules).
// ───────────────────────────────────────────────────────────────────────

export class ContextLoaderCrossProjectError extends Error {
  public readonly requestedProjectId: string;
  public readonly actualProjectId: string;
  public readonly scope: Extract<ContextScope, "session" | "plan">;
  public readonly secondaryId: string;

  constructor(
    requestedProjectId: string,
    actualProjectId: string,
    scope: Extract<ContextScope, "session" | "plan">,
    secondaryId: string,
  ) {
    super(
      `ContextLoader: ${scope} ${secondaryId} belongs to project ${actualProjectId}, ` +
        `not requested project ${requestedProjectId}. Cross-project reads are forbidden.`,
    );
    this.name = "ContextLoaderCrossProjectError";
    this.requestedProjectId = requestedProjectId;
    this.actualProjectId = actualProjectId;
    this.scope = scope;
    this.secondaryId = secondaryId;
  }
}

// ───────────────────────────────────────────────────────────────────────
// ContextLoader — the single code path for assembling LLM context.
//
// V1 enforces the project boundary; the cross-project assertion runs
// serially BEFORE any data fans out. Once the assertion passes, the
// per-field loads run in parallel via Promise.all so the round-trip
// budget for a context build is one assert + max(individual load).
// ───────────────────────────────────────────────────────────────────────

export class ContextLoader {
  constructor(private readonly db: SupabaseClient<Database>) {}

  buildFor(projectId: string, scope: "project"): Promise<ProjectContext>;
  buildFor(
    projectId: string,
    scope: "session",
    sessionId: string,
  ): Promise<SessionContext>;
  buildFor(projectId: string, scope: "plan", planId: string): Promise<PlanContext>;
  async buildFor(
    projectId: string,
    scope: ContextScope,
    secondaryId?: string,
  ): Promise<ProjectContext | SessionContext | PlanContext> {
    if (scope === "session") {
      if (!secondaryId) {
        throw new Error("ContextLoader.buildFor('session') requires sessionId");
      }
      // Cross-project gate runs serially BEFORE the parallel loads.
      // A wrong projectId throws ContextLoaderCrossProjectError without
      // fanning out any data queries.
      const { specId } = await this.loadAndAssertSession(projectId, secondaryId);
      return this.loadSessionContext(projectId, secondaryId, specId);
    }
    if (scope === "plan") {
      if (!secondaryId) {
        throw new Error("ContextLoader.buildFor('plan') requires planId");
      }
      await this.assertPlanInProject(projectId, secondaryId);
      return this.stubPlanContext(projectId, secondaryId);
    }
    return this.loadProjectContext(projectId);
  }

  // Combined load + project-id assertion for a session. Was
  // assertSessionInProject (which discarded the row); widened select
  // returns spec_id for reuse in the spec lookup. project_id is verified
  // before the function returns — no need to surface it back.
  private async loadAndAssertSession(
    projectId: string,
    sessionId: string,
  ): Promise<{ specId: string | null }> {
    const { data, error } = await this.db
      .from("sessions")
      .select("project_id, spec_id")
      .eq("id", sessionId)
      .single();
    if (error) {
      throw new Error(
        `ContextLoader: failed to look up session ${sessionId}: ${error.message}`,
      );
    }
    if (!data) {
      throw new Error(`ContextLoader: session ${sessionId} not found`);
    }
    if (data.project_id !== projectId) {
      throw new ContextLoaderCrossProjectError(
        projectId,
        data.project_id,
        "session",
        sessionId,
      );
    }
    return { specId: data.spec_id };
  }

  private async assertPlanInProject(
    projectId: string,
    planId: string,
  ): Promise<void> {
    const { data, error } = await this.db
      .from("plans")
      .select("project_id")
      .eq("id", planId)
      .single();
    if (error) {
      throw new Error(
        `ContextLoader: failed to look up plan ${planId}: ${error.message}`,
      );
    }
    if (!data) {
      throw new Error(`ContextLoader: plan ${planId} not found`);
    }
    if (data.project_id !== projectId) {
      throw new ContextLoaderCrossProjectError(
        projectId,
        data.project_id,
        "plan",
        planId,
      );
    }
  }

  // Project-scope load: claudeMd + recentDecisions + specs in parallel.
  // `skills` stays session-scope-only (Slice 3 convention; no caller has
  // asked for project-scope skills yet).
  private async loadProjectContext(
    projectId: string,
  ): Promise<ProjectContext> {
    const [claudeMd, recentDecisions, specs] = await Promise.all([
      this.loadProjectClaudeMd(projectId),
      this.loadRecentDecisions(projectId),
      this.loadSpecs(projectId),
    ]);
    return {
      projectId,
      claudeMd,
      specs,
      skills: [],
      recentDecisions,
    };
  }

  // Session-scope load: the three project-level reads + skills + (optional)
  // spec + priorDebrief, all in one Promise.all. The conditional spec
  // resolves to a settled Promise so the fan-out width stays at six and
  // the array tuple type is stable.
  private async loadSessionContext(
    projectId: string,
    sessionId: string,
    specId: string | null,
  ): Promise<SessionContext> {
    const [claudeMd, recentDecisions, specs, skills, spec, priorDebrief] =
      await Promise.all([
        this.loadProjectClaudeMd(projectId),
        this.loadRecentDecisions(projectId),
        this.loadSpecs(projectId),
        listSkillsForProject(this.db, projectId),
        specId !== null ? this.loadSpec(specId) : Promise.resolve(null),
        this.loadPriorDebrief(sessionId),
      ]);
    return {
      projectId,
      claudeMd,
      specs,
      skills,
      recentDecisions,
      sessionId,
      spec,
      priorDebrief,
    };
  }

  // Plan scope keeps Slice 1's stubs. Slice 7 will fill brief /
  // dialecticState; the project-level fields (claudeMd / specs /
  // recentDecisions) are deliberately left stubbed too, so plan scope
  // diverges from project + session scope until Slice 7 closes the
  // symmetry. The shared `ProjectContext` types still hold — `[]`
  // satisfies `readonly Spec[]` etc.
  private stubPlanContext(projectId: string, planId: string): PlanContext {
    return {
      projectId,
      claudeMd: null,
      specs: [],
      skills: [],
      recentDecisions: [],
      planId,
      brief: null,
      dialecticState: [],
    };
  }

  // ─── Per-field loaders ──────────────────────────────────────────────

  private async loadProjectClaudeMd(
    projectId: string,
  ): Promise<string | null> {
    const { data, error } = await this.db
      .from("projects")
      .select("claude_md")
      .eq("id", projectId)
      .single();
    if (error) {
      throw new Error(
        `ContextLoader: failed to load project ${projectId} claude_md: ${error.message}`,
      );
    }
    return data?.claude_md ?? null;
  }

  // Backed by `decisions_project_idx (project_id, created_at desc)`
  // from 0001 — index covers both the filter and the order. The 30-row
  // cap is the brief's §7 figure.
  private async loadRecentDecisions(projectId: string): Promise<Decision[]> {
    const { data, error } = await this.db
      .from("decisions")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) {
      throw new Error(
        `ContextLoader: failed to load recent decisions for project ${projectId}: ${error.message}`,
      );
    }
    return data ?? [];
  }

  // No index on `specs.project_id` today — accept the seq-scan over a
  // small table (<10 rows in dev). Add an index in a later migration if
  // specs growth becomes a concern.
  private async loadSpecs(projectId: string): Promise<Spec[]> {
    const { data, error } = await this.db
      .from("specs")
      .select("*")
      .eq("project_id", projectId);
    if (error) {
      throw new Error(
        `ContextLoader: failed to load specs for project ${projectId}: ${error.message}`,
      );
    }
    return data ?? [];
  }

  // maybeSingle defends against a stale FK: the spec referenced by the
  // session may have been deleted after the session was created.
  private async loadSpec(specId: string): Promise<Spec | null> {
    const { data, error } = await this.db
      .from("specs")
      .select("*")
      .eq("id", specId)
      .maybeSingle();
    if (error) {
      throw new Error(
        `ContextLoader: failed to load spec ${specId}: ${error.message}`,
      );
    }
    return data;
  }

  // Backed by `debriefs_session_idx (session_id, created_at desc)`
  // from 0009. maybeSingle because most sessions have zero debriefs
  // until 6c wires the generator.
  private async loadPriorDebrief(sessionId: string): Promise<Debrief | null> {
    const { data, error } = await this.db
      .from("debriefs")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      throw new Error(
        `ContextLoader: failed to load prior debrief for session ${sessionId}: ${error.message}`,
      );
    }
    return data;
  }
}
