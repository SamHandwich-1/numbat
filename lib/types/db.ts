import type {
  DebriefContentT,
  DecisionPayloadT,
  LlmCallErrorT,
  PlanStageContentT,
  SessionLastErrorT,
  SpecAcceptanceCriteriaT,
  SpecFilesAffectedT,
  SpecOpenQuestionsT,
  WorktreeDiffT,
} from "@/lib/types/jsonb";

// ───────────────────────────────────────────────────────────────────────
// Status / enum helper types (text + check constraint columns)
// ───────────────────────────────────────────────────────────────────────

export type SessionStatus =
  | "idle"
  | "planning"
  | "running"
  | "awaiting_review"
  | "blocked"
  | "done"
  | "killed"
  | "killing"; // Slice 4: transient state between operator kill and worker SDK teardown

export type PlanStatus =
  | "drafting"
  | "critiquing"
  | "considering"
  | "validating"
  | "ready"
  | "shipped"
  | "abandoned";

export type PlanStageActor = "opus" | "grok" | "claude_agent";

export type PlanStageAction =
  | "draft"
  | "critique"
  | "consider"
  | "validate"
  | "execute"
  | "debrief";

export type DecisionType =
  | "approve"
  | "redirect"
  | "kill"
  | "accept_critique"
  | "reject_critique"
  | "ship"
  | "edit_spec"
  | "start_work"
  | "dismiss"
  | "undismiss"
  // Slice 6 sub-slice 6a: extended via migration 0009 to match the
  // 11-value SQL check constraint. Three-place sync (SQL constraint,
  // TS union, Zod DecisionPayload variant) — see jsonb.ts for the
  // matching stub variant. 6g extends the Zod variant with create_plan-
  // specific fields when wiring lib/orchestration/create-plan.ts.
  | "create_plan";

export type DebriefType =
  | "direct"
  | "bilby_draft"
  | "bilby_critique"
  | "bilby_consider"
  | "bilby_validate";

export type LlmProvider = "anthropic" | "xai" | "agent_sdk";

// ───────────────────────────────────────────────────────────────────────
// Row types (one per table)
// ───────────────────────────────────────────────────────────────────────

export type Project = {
  id: string;
  slug: string;
  name: string;
  short_code: string;
  repo_path: string;
  claude_md: string | null;
  chip_bg: string;
  chip_fg: string;
  created_at: string;
};
export type ProjectInsert = Omit<Project, "id" | "created_at"> & {
  id?: string;
  created_at?: string;
};

export type Session = {
  id: string;
  project_id: string;
  slice_name: string;
  worktree_path: string | null;
  task: string;
  status: SessionStatus;
  // Live during running/idle (worker's most recent tool-use file path);
  // snapshot once terminal — see docs/decisions/0010-current-step-on-terminal-transitions.md.
  current_step: string | null;
  blocking_reason: string | null;
  spec_id: string | null;
  agent_session_id: string | null;
  last_error: SessionLastErrorT | null;
  // Slice 4: parsed git-diff output written by the worker on transition
  // to awaiting_review. null until then. Shape validated against the
  // WorktreeDiff Zod schema in lib/types/jsonb.ts.
  diff: WorktreeDiffT | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  // Slice 5: soft-hide marker for terminal rows. Sessions list filters
  // `dismissed_at IS NULL` by default; "show dismissed" toggle removes
  // the filter. Reversible via UPDATE sessions SET dismissed_at = NULL.
  // Added by migration 0007. See
  // docs/decisions/0009-slice-5-operator-action-surface-session-lifecycle.md §D.
  dismissed_at: string | null;
};
export type SessionInsert = Omit<
  Session,
  "id" | "created_at" | "updated_at" | "completed_at" | "diff" | "dismissed_at"
> & {
  id?: string;
  created_at?: string;
  updated_at?: string;
  completed_at?: string | null;
  diff?: WorktreeDiffT | null;
  dismissed_at?: string | null;
};

export type Plan = {
  id: string;
  project_id: string;
  title: string;
  brief: string;
  status: PlanStatus;
  spec_id: string | null;
  created_at: string;
  updated_at: string;
};
export type PlanInsert = Omit<Plan, "id" | "created_at" | "updated_at"> & {
  id?: string;
  created_at?: string;
  updated_at?: string;
};

export type PlanStage = {
  id: string;
  plan_id: string;
  stage_num: number;
  actor: PlanStageActor;
  action: PlanStageAction;
  llm_provider: LlmProvider | null;
  model: string | null;
  content: PlanStageContentT;
  duration_ms: number | null;
  created_at: string;
};
export type PlanStageInsert = Omit<PlanStage, "id" | "created_at"> & {
  id?: string;
  created_at?: string;
};

export type Spec = {
  id: string;
  project_id: string;
  plan_id: string | null;
  goal: string;
  out_of_scope: string | null;
  files_affected: SpecFilesAffectedT | null;
  acceptance_criteria: SpecAcceptanceCriteriaT | null;
  open_questions: SpecOpenQuestionsT | null;
  version: number;
  created_at: string;
};
export type SpecInsert = Omit<Spec, "id" | "created_at" | "version"> & {
  id?: string;
  created_at?: string;
  version?: number;
};

export type Decision = {
  id: string;
  project_id: string;
  session_id: string | null;
  plan_id: string | null;
  type: DecisionType;
  context: string | null;
  payload: DecisionPayloadT | null;
  created_at: string;
};
export type DecisionInsert = Omit<Decision, "id" | "created_at"> & {
  id?: string;
  created_at?: string;
};

export type Skill = {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  prompt_template: string;
  usage_count: number;
  created_at: string;
  updated_at: string;
};
export type SkillInsert = Omit<
  Skill,
  "id" | "created_at" | "updated_at" | "usage_count"
> & {
  id?: string;
  created_at?: string;
  updated_at?: string;
  usage_count?: number;
};

// Debrief — written at the end of every Direct session (and, from Slice 7,
// at each Bilby stage). `debrief_type` discriminates the `content` shape;
// the inferred `DebriefContentT` is currently the 'direct' four-section
// schema from jsonb.ts. Gate 4 generalises `content` to a discriminated
// union including the four bilby_* arms (currently TODO stubs). Per
// migration 0009. At least one of session_id / plan_stage_id is set
// (debriefs_target_check).
export type Debrief = {
  id: string;
  project_id: string;
  session_id: string | null;
  plan_stage_id: string | null;
  debrief_type: DebriefType;
  content: DebriefContentT;
  llm_call_id: string | null;
  prompt_version: string;
  duration_ms: number | null;
  created_at: string;
};
export type DebriefInsert = Omit<Debrief, "id" | "created_at"> & {
  id?: string;
  created_at?: string;
};

// LlmCall — note cost_usd is `string` because numeric(10,6) is delivered as
// string by the postgrest JSON encoder (avoids JS number precision loss).
// Convert at the boundary via Number(row.cost_usd).
export type LlmCall = {
  id: string;
  project_id: string;
  plan_stage_id: string | null;
  session_id: string | null;
  provider: LlmProvider;
  model: string;
  prompt_hash: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  duration_ms: number | null;
  cost_usd: string;
  error: LlmCallErrorT | null;
  created_at: string;
};
export type LlmCallInsert = Omit<LlmCall, "id" | "created_at"> & {
  id?: string;
  created_at?: string;
};

// ───────────────────────────────────────────────────────────────────────
// Database shape consumed by createClient<Database>
//
// Hand-written. Kept in sync with supabase/migrations/0001_initial.sql.
// Migrate to `supabase gen types typescript` once the cloud project is
// stable so future migrations can't let SQL and TS drift silently.
// ───────────────────────────────────────────────────────────────────────

type TableShape<R, I> = {
  Row: R;
  Insert: I;
  Update: Partial<I>;
  Relationships: never[];
};

export type Database = {
  public: {
    Tables: {
      projects: TableShape<Project, ProjectInsert>;
      plans: TableShape<Plan, PlanInsert>;
      specs: TableShape<Spec, SpecInsert>;
      sessions: TableShape<Session, SessionInsert>;
      plan_stages: TableShape<PlanStage, PlanStageInsert>;
      decisions: TableShape<Decision, DecisionInsert>;
      skills: TableShape<Skill, SkillInsert>;
      llm_calls: TableShape<LlmCall, LlmCallInsert>;
      debriefs: TableShape<Debrief, DebriefInsert>;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
