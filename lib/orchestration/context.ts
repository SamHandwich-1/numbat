import type { SupabaseClient } from "@supabase/supabase-js";
import { listSkillsForProject } from "@/lib/supabase/queries/skills";
import type { Database, Skill } from "@/lib/types/db";

// ───────────────────────────────────────────────────────────────────────
// Scopes
// ───────────────────────────────────────────────────────────────────────

export type ContextScope = "project" | "session" | "plan";

// V1 stub shapes. Slice 5 / 6 fills these in with real CLAUDE.md / specs /
// decisions / brief / dialectic state. The fields are typed but empty so
// callers can already write code against the shape.
//
// `skills` is widened from `readonly never[]` to `readonly Skill[]` in
// Slice 3 — the session scope now actually fetches the project's skills
// for the Reply composer's quick-move chips. The project scope still
// returns `[]` until later slices fill it in; the type is consistent
// across scopes so callers don't have to special-case.
export type ProjectContext = {
  projectId: string;
  claudeMd: string | null;
  specs: readonly never[];
  skills: readonly Skill[];
  recentDecisions: readonly never[];
};

export type SessionContext = ProjectContext & {
  sessionId: string;
  spec: null;
  priorDebrief: null;
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
// V1 enforces the project boundary; loaders return typed empty shapes.
// Slice 5 / 6 fills the shapes in.
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
      await this.assertSessionInProject(projectId, secondaryId);
      // Skills load runs AFTER the project assertion. The assertion is
      // the project-scoping gate; if it throws, the skills query never
      // runs. Implicit invariant — do not reorder.
      const skills = await listSkillsForProject(this.db, projectId);
      return this.sessionContext(projectId, secondaryId, skills);
    }
    if (scope === "plan") {
      if (!secondaryId) {
        throw new Error("ContextLoader.buildFor('plan') requires planId");
      }
      await this.assertPlanInProject(projectId, secondaryId);
      return this.emptyPlan(projectId, secondaryId);
    }
    return this.emptyProject(projectId);
  }

  private async assertSessionInProject(
    projectId: string,
    sessionId: string,
  ): Promise<void> {
    const { data, error } = await this.db
      .from("sessions")
      .select("project_id")
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

  // V1 stubs. Slice 5 wires the rest of the loaders (claudeMd, specs,
  // recentDecisions). Slice 3 populates `skills` for the session scope.
  private emptyProject(projectId: string): ProjectContext {
    return {
      projectId,
      claudeMd: null,
      specs: [],
      skills: [],
      recentDecisions: [],
    };
  }
  private sessionContext(
    projectId: string,
    sessionId: string,
    skills: readonly Skill[],
  ): SessionContext {
    return {
      ...this.emptyProject(projectId),
      skills,
      sessionId,
      spec: null,
      priorDebrief: null,
    };
  }
  private emptyPlan(projectId: string, planId: string): PlanContext {
    return {
      ...this.emptyProject(projectId),
      planId,
      brief: null,
      dialecticState: [],
    };
  }
}
