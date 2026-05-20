// lib/feathertail/types.ts — type aliases for Feathertail (the execution
// layer). Re-exports the inferred Zod types from lib/types/jsonb under
// shorter Feathertail-local names. The Zod schemas themselves stay in
// lib/types/jsonb (the canonical home for jsonb shapes); import those
// directly from there when validating at boundaries.

import type {
  WorktreeDiffT,
  WorktreeDiffFileT,
} from "@/lib/types/jsonb";

export type WorktreeDiff = WorktreeDiffT;
export type WorktreeDiffFile = WorktreeDiffFileT;
export type WorktreeDiffFileStatus = WorktreeDiffFileT["status"];
