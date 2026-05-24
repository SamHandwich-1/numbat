import type { SessionStatus } from "@/lib/types/db";

// Filters that narrow the sessions dataset. Consumed by listSessions
// (server-side query) and by the URL-param filter components.
//
// `projectShortCode` is plain string — the four-project literal union
// was removed in slice 2a.1 once chip colours moved from a typed
// constant to per-project row data (chip_bg / chip_fg on projects).
// The project set is dynamic data, not a closed enum.
//
// Focus (?focus=<short_code>) is a render hint, not a query filter —
// off-project sessions are dimmed, not removed. Read separately from
// useSearchParams() in FocusBanner + SessionList.
export type SessionFilters = {
  projectShortCode?: string;
  status?: SessionStatus;
  // Slice 5 — when false-or-absent, listSessions filters `dismissed_at
  // IS NULL` (the default Sessions-list view hides dismissed rows).
  // When true, the filter is REMOVED entirely (no-filter, not IS NOT
  // NULL, per docs/decisions/0009-slice-5-...md Stage 3: "operator
  // wants to see everything when investigating").
  includeDismissed?: boolean;
};

// Tailwind v4's @theme parser treats double-hyphens as modifier
// separators, so --status-awaiting-review compiled to nothing. Hence
// --status-review with explicit DB enum → token mapping. Do not
// rename status-review to status-awaiting-review without testing
// compilation.
export const STATUS_TO_TOKEN: Record<SessionStatus, string> = {
  idle: "--status-idle",
  planning: "--status-planning",
  running: "--status-running",
  awaiting_review: "--status-review",
  blocked: "--status-blocked",
  done: "--status-done",
  killed: "--status-killed",
  // Slice 4: transient "stopping…" state. Maps to the same token as
  // `killed` (dimmed grey) so the pill colour reads as terminal-ish,
  // but the label in the UI is "killing" to communicate in-progress.
  killing: "--status-killed",
};
