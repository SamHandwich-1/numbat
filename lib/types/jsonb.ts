import { z } from "zod";

// sessions.last_error
// `operator` source covers manual termination via the Slice 3 Kill action —
// not an error from the agent/worker/db/validator, but an authored
// termination reason. Additive enum extension; existing call sites are
// unaffected.
// `watchdog` (Slice 4) covers reapStaleKillingSessions timing out a
// session stuck in `killing` — the worker may have died for any reason,
// or the realtime kill event may never have arrived; calling it a
// `worker` error misrepresents what actually happened. Same additive
// pattern.
export const SessionLastError = z.object({
  message: z.string(),
  stack: z.string().optional(),
  source: z.enum([
    "agent_sdk",
    "worker",
    "supabase",
    "validation",
    "operator",
    "watchdog",
  ]),
  occurred_at: z.string().datetime(),
});

// specs.files_affected
export const SpecFilesAffected = z.array(
  z.object({
    path: z.string(),
    status: z.enum(["created", "modified", "deleted", "renamed"]),
    rename_from: z.string().optional(),
  }),
);

// specs.acceptance_criteria
export const SpecAcceptanceCriteria = z.array(
  z.object({
    id: z.string(),
    text: z.string(),
    satisfied: z.boolean().default(false),
  }),
);

// specs.open_questions
export const SpecOpenQuestions = z.array(
  z.object({
    id: z.string(),
    question: z.string(),
    raised_at: z.string().datetime(),
    resolved: z.boolean().default(false),
    resolution: z.string().optional(),
  }),
);

// decisions.payload — discriminated union by decision type.
//
// Most variants record human-operator actions (approve, kill,
// redirect, ship, etc.). `start_work` is the exception: it records
// the rules-based router's classification when the operator submits
// a brief via the Start Work surface. NOT a human approval — use
// `approve` for those — but the audit trail of the system routing
// on the operator's behalf, and the discriminator V2's LLM router
// will train against.
//
// SYNC: `start_work.matched_rule` enum mirrors `RouterMatchedRule`
// in `lib/orchestration/router.ts`. Update both sides together —
// add a rule there, add the literal here. No codebase pattern yet
// for auto-deriving zod enums from TS unions; this comment is the
// V1 guarantee.
//
// Slice 5 step 1 — snapshot fields. Added to the four variants
// currently in live use (approve, redirect, kill, start_work) so the
// decision row stays legible after its FK referent is deleted:
//
//   - session_label: snapshot of sessions.slice_name at decision-insert
//     time. Not a live reference; renames after insert are not tracked.
//   - plan_label:    snapshot of plans.title at decision-insert time.
//   - Both are NULL-allowed (decision targeted a side that has no parent,
//     or the parent's source field was empty). Render NULL as
//     `<unnamed session>` / `<unnamed plan>` in UI.
//
// Backed by ON DELETE SET NULL on both decisions.session_id and
// decisions.plan_id per migration 0007 — the labels persist after the
// parent row is deleted, which is the whole point.
//
// The other four variants (accept_critique, reject_critique, ship,
// edit_spec) are Bilby-pipeline-related and don't yet appear in live
// decision rows per Step 0a §A's sample. They're left unextended for
// now; extend them when a Bilby flow produces snapshot-relevant rows.
//
// Slice 5 step 4a — two new variants. `dismiss` and `undismiss` are
// operator lifecycle actions surfaced via the Slice 5 dismiss UI (0009
// §D). Both carry the snapshot fields uniformly; no additional payload
// (dismiss is low-stakes, so no reason field is required — easy to add
// later if the audit value of a reason proves useful).
const DecisionSnapshotFields = {
  session_label: z.string().optional(),
  plan_label: z.string().optional(),
};

export const DecisionPayload = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("approve"),
    note: z.string().optional(),
    ...DecisionSnapshotFields,
  }),
  z.object({
    type: z.literal("redirect"),
    reply_text: z.string(),
    ...DecisionSnapshotFields,
  }),
  z.object({
    type: z.literal("kill"),
    reason: z.string(),
    ...DecisionSnapshotFields,
  }),
  z.object({ type: z.literal("accept_critique"), critique_id: z.string() }),
  z.object({
    type: z.literal("reject_critique"),
    critique_id: z.string(),
    reason: z.string(),
  }),
  z.object({ type: z.literal("ship"), spec_id: z.string() }),
  z.object({ type: z.literal("edit_spec"), spec_id: z.string(), diff: z.string() }),
  z.object({
    type: z.literal("start_work"),
    routed_to: z.enum(["direct", "bilby"]),
    matched_rule: z.enum([
      "length_under_200",
      "keyword_fix",
      "keyword_typo",
      "keyword_copy",
      "keyword_style",
      "question_mark",
      "default_bilby",
      "manual",
    ]),
    reason: z.string(),
    ...DecisionSnapshotFields,
  }),
  z.object({
    type: z.literal("dismiss"),
    ...DecisionSnapshotFields,
  }),
  z.object({
    type: z.literal("undismiss"),
    ...DecisionSnapshotFields,
  }),
  // Slice 6 sub-slice 6a — minimum-viable stub variant to keep the
  // three-place sync (SQL constraint 0009, TS DecisionType union,
  // Zod DecisionPayload variant) intact after `create_plan` joined
  // the constraint. 6g extends with create_plan-specific fields
  // (`source: 'start_work' | 'operator_initiated'`, optional
  // `routed_to`/`matched_rule`/`reason` when source is `start_work`)
  // when wiring lib/orchestration/create-plan.ts.
  z.object({
    type: z.literal("create_plan"),
    ...DecisionSnapshotFields,
  }),
]);

// llm_calls.error — populated when a call failed
export const LlmCallError = z.object({
  message: z.string(),
  subtype: z.string().optional(),         // 'error_during_execution', 'error_max_turns', etc.
  terminal_reason: z.string().optional(),
  errors: z.array(z.string()).optional(),
});

// plan_stages.content — discriminated union by action.
//
// The four Bilby dialectic actions (draft, critique, consider, validate)
// carry full audit fields — the prompt sent to the model, the response,
// model id, finish reason, and an optional error if the call failed
// after retries. These shapes were tightened in the proto-Bilby script
// (scripts/bilby-dialectic.ts); the Stage 6 schema-tightening note in
// the prior comment is closed out by this commit.
//
// `execute` and `debrief` belong to Feathertail (Slice 3+) and keep the
// permissive `markdown` shape until those flows tighten their schemas.
const BilbyAuditFields = {
  prompt: z.string(),
  response: z.string(),
  model: z.string(),
  finish_reason: z.string(),
  error: z
    .object({
      message: z.string(),
      subtype: z.string().optional(),
      terminal_reason: z.string().optional(),
      errors: z.array(z.string()).optional(),
    })
    .optional(),
};

export const PlanStageContent = z.discriminatedUnion("action", [
  z.object({ action: z.literal("draft"), ...BilbyAuditFields }),
  z.object({ action: z.literal("critique"), ...BilbyAuditFields }),
  z.object({ action: z.literal("consider"), ...BilbyAuditFields }),
  z.object({ action: z.literal("validate"), ...BilbyAuditFields }),
  z.object({ action: z.literal("execute"), markdown: z.string() }),
  z.object({ action: z.literal("debrief"), markdown: z.string() }),
]);

// Debrief content — the four-section + optional new-concept structure
// produced by the Opus debrief stage. Not yet persisted in V1 (Slice 5
// decides on the persistence column); for Slice 3 this schema validates
// the mock fixture at module load. Reuse this schema when persistence
// lands.
export const DebriefNewConcept = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});

export const DebriefContent = z.object({
  what_we_did: z.string().min(1),
  where_this_fits: z.string().min(1),
  why_it_matters: z.string().min(1),
  what_went_wrong_or_next: z.string().min(1),
  new_concept: DebriefNewConcept.optional(),
});

// sessions.diff — parsed git-diff output from the worker's post-session
// captureDiff() call (lib/feathertail/diff.ts). Shape matches Slice 3's
// MockedDiff so the page consumer (DiffPreview) doesn't need to change.
// Same validation pattern as DebriefContent: parsed at insert (worker)
// and at read (page) so drift surfaces as a Zod parse error rather
// than a silent UI bug.
export const WorktreeDiffFile = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().nullable(),
});

export const WorktreeDiff = z.object({
  files: z.array(WorktreeDiffFile),
  totals: z.object({
    files_changed: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
});

export type SessionLastErrorT = z.infer<typeof SessionLastError>;
export type SpecFilesAffectedT = z.infer<typeof SpecFilesAffected>;
export type SpecAcceptanceCriteriaT = z.infer<typeof SpecAcceptanceCriteria>;
export type SpecOpenQuestionsT = z.infer<typeof SpecOpenQuestions>;
export type DecisionPayloadT = z.infer<typeof DecisionPayload>;
export type LlmCallErrorT = z.infer<typeof LlmCallError>;
export type PlanStageContentT = z.infer<typeof PlanStageContent>;
export type DebriefContentT = z.infer<typeof DebriefContent>;
export type DebriefNewConceptT = z.infer<typeof DebriefNewConcept>;
export type WorktreeDiffT = z.infer<typeof WorktreeDiff>;
export type WorktreeDiffFileT = z.infer<typeof WorktreeDiffFile>;
