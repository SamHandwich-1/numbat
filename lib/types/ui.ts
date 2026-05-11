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
};
