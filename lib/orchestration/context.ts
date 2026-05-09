import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/db";

// ───────────────────────────────────────────────────────────────────────
// Scopes
// ───────────────────────────────────────────────────────────────────────

export type ContextScope = "project" | "session" | "plan";

// V1 stub shapes. Slice 5 / 6 fills these in with real CLAUDE.md / specs /
// decisions / brief / dialectic state. The fields are typed but empty so
// callers can already write code against the shape.
export type ProjectContext = {
  projectId: string;
  claudeMd: string | null;
  specs: readonly never[];
  skills: readonly never[];
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
      return this.emptySession(projectId, secondaryId);
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

  // V1 stubs. Slice 5 wires real loaders.
  private emptyProject(projectId: string): ProjectContext {
    return {
      projectId,
      claudeMd: null,
      specs: [],
      skills: [],
      recentDecisions: [],
    };
  }
  private emptySession(projectId: string, sessionId: string): SessionContext {
    return {
      ...this.emptyProject(projectId),
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
