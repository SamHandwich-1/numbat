import { z } from "zod";

// sessions.last_error
// `operator` source covers manual termination via the Slice 3 Kill action —
// not an error from the agent/worker/db/validator, but an authored
// termination reason. Additive enum extension; existing call sites are
// unaffected.
export const SessionLastError = z.object({
  message: z.string(),
  stack: z.string().optional(),
  source: z.enum(["agent_sdk", "worker", "supabase", "validation", "operator"]),
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
export const DecisionPayload = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approve"), note: z.string().optional() }),
  z.object({ type: z.literal("redirect"), reply_text: z.string() }),
  z.object({ type: z.literal("kill"), reason: z.string() }),
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
// Permissive stub shapes for V1; Slice 6 (Bilby) tightens each variant
// when the dialectic prompts are written.
export const PlanStageContent = z.discriminatedUnion("action", [
  z.object({ action: z.literal("draft"), markdown: z.string() }),
  z.object({ action: z.literal("critique"), markdown: z.string() }),
  z.object({ action: z.literal("consider"), markdown: z.string() }),
  z.object({ action: z.literal("validate"), markdown: z.string() }),
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

export type SessionLastErrorT = z.infer<typeof SessionLastError>;
export type SpecFilesAffectedT = z.infer<typeof SpecFilesAffected>;
export type SpecAcceptanceCriteriaT = z.infer<typeof SpecAcceptanceCriteria>;
export type SpecOpenQuestionsT = z.infer<typeof SpecOpenQuestions>;
export type DecisionPayloadT = z.infer<typeof DecisionPayload>;
export type LlmCallErrorT = z.infer<typeof LlmCallError>;
export type PlanStageContentT = z.infer<typeof PlanStageContent>;
export type DebriefContentT = z.infer<typeof DebriefContent>;
export type DebriefNewConceptT = z.infer<typeof DebriefNewConcept>;
