import { z } from "zod";
import { DebriefContent, type DebriefContentT } from "@/lib/types/jsonb";

// Slice 6 sub-slice 6a — Zod discriminated-union schema for the
// debriefs.content column.
//
// The 'direct' arm reuses DebriefContent from jsonb.ts (added in Slice 3
// to validate the mock debrief fixture). Renaming wouldn't earn its keep
// — the existing tests, mock, and db.ts row-type all reference the
// jsonb.ts name. See §3.8 of the sub-slice 6a plan and the 0015
// decisions log for the divergence-from-planning-doc rationale: the
// existing `{title, body}` convention for `new_concept` wins over the
// planning-doc `{name, definition}`.
//
// Slice 7 will populate the bilby_* arms with their actual content
// shapes — Bilby drafts, critiques, considered responses, and
// validations have different shapes from a Direct debrief (they're
// structured around the dialectic stages, not the four-section format).
// Until then, these are placeholder schemas that the discriminated
// union can match against but no production code should hit. The
// runtime guard is the SQL check constraint in 0009 — only 'direct'
// debrief_type rows exist in V1.
//
// `z.never()` for the bilby_* content fields is deliberate: it makes
// any attempt to parse a bilby_* row fail at the content layer, AND it
// narrows the TS type to `never` so accessing `.content.foo` on a
// bilby_* arm is a compile error. Slice 7 replaces z.never() with real
// schemas per arm.

// Re-export of the 'direct' content shape under the explicit
// `Direct` name. Callers that care about which arm they're validating
// can import this; callers that just want the existing four-section
// schema continue to import DebriefContent from jsonb.ts.
export const DirectDebriefSchema = DebriefContent;
export type DirectDebriefT = DebriefContentT;

// Discriminated union over the row's (debrief_type, content) pair.
// Validates the discriminator + the correctly-shaped content together,
// so callers can hand the row over and get type-narrowed access.
export const DebriefSchema = z.discriminatedUnion("debrief_type", [
  z.object({
    debrief_type: z.literal("direct"),
    content: DirectDebriefSchema,
  }),
  z.object({
    debrief_type: z.literal("bilby_draft"),
    content: z.never(), // TODO Slice 7
  }),
  z.object({
    debrief_type: z.literal("bilby_critique"),
    content: z.never(), // TODO Slice 7
  }),
  z.object({
    debrief_type: z.literal("bilby_consider"),
    content: z.never(), // TODO Slice 7
  }),
  z.object({
    debrief_type: z.literal("bilby_validate"),
    content: z.never(), // TODO Slice 7
  }),
]);

export type DebriefT = z.infer<typeof DebriefSchema>;
