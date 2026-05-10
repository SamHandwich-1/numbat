import type { SessionStatus } from "@/lib/types/db";

// The four projects seeded in slice 1's config/projects.json. The literal
// union is the contract — adding a project requires updating BOTH
// config/projects.json AND PROJECT_CHIP_COLORS here, or TypeScript will
// fail to compile.
export type ProjectShortCode = "AO" | "WT" | "BB" | "NB";

// Filters that narrow the sessions dataset. Consumed by listSessions
// (server-side query) and by the URL-param filter components.
//
// Focus (?focus=<short_code>) is a render hint, not a query filter —
// off-project sessions are dimmed, not removed. Read separately from
// useSearchParams() in FocusBanner + SessionList.
export type SessionFilters = {
  projectShortCode?: ProjectShortCode;
  status?: SessionStatus;
};

// Per-project chip colours. Distinct from reserved status colours
// (mint/amber/coral) and from Bilby accents (Opus violet, Grok yellow).
// All four bgs sit in the warm-dark family; fgs picked for contrast.
export const PROJECT_CHIP_COLORS: Record<
  ProjectShortCode,
  { bg: string; fg: string }
> = {
  AO: { bg: "#3b4a4f", fg: "#cfe6e8" }, // alice-os — desaturated teal
  WT: { bg: "#4a3a2c", fg: "#e6d3b8" }, // wedgetail — warm umber
  BB: { bg: "#3d3a4a", fg: "#cdc6e0" }, // bowerbird — dim plum
  NB: { bg: "#2c3e3a", fg: "#bcd0c7" }, // numbat — forest moss
};

// Type guard for strings that may or may not be a known short code.
// Used at the DB → typed-code boundary — e.g. validating a session's
// project.short_code before indexing into PROJECT_CHIP_COLORS, or
// narrowing a URL search param string to a SessionFilters.projectShortCode.
export function isProjectShortCode(s: string): s is ProjectShortCode {
  return s === "AO" || s === "WT" || s === "BB" || s === "NB";
}

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
