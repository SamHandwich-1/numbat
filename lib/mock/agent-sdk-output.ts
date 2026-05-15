import { DebriefContent, type DebriefContentT } from "@/lib/types/jsonb";
import type { Session } from "@/lib/types/db";

// Mocked Agent SDK output for Slice 3. Reflects what a real session
// will produce once Slice 4 wires the SDK + Slice 5 wires the Opus
// debrief generator:
//
//   - `debrief` shape mirrors `DebriefContent` from lib/types/jsonb —
//     the same schema will validate real debriefs when persistence
//     lands (Slice 5).
//   - `diff` shape mirrors what `lib/feathertail/diff.ts` will return
//     in Slice 4 from `git status --porcelain` + `git diff` against
//     the session's worktree (per the Slice 0 spike memo). The SDK's
//     `tool_use` event stream is intent, not ground truth, so we do
//     NOT model `SDKFilesPersistedEvent`.
//
// All Slice 3 review-flow rendering reads from `getMockedOutputForSession`,
// which currently returns the same sample regardless of session id.
// Slice 4 swaps this for a real worktree parse.

export type MockedDiffFileStatus = "added" | "modified" | "deleted";

export type MockedDiffFile = {
  // Repo-relative path. Long paths must ellipsise at 375px without
  // forcing horizontal scroll — see components/review/diff-preview.tsx.
  path: string;
  status: MockedDiffFileStatus; // maps to + / M / − marker in the UI
  additions: number;
  deletions: number;
  // Unified-diff hunks. Optional in Slice 3 (file-list view only); the
  // shape is reserved so a Slice 4 hunk-level toggle is additive.
  patch: string | null;
};

export type MockedDiff = {
  files: MockedDiffFile[];
  totals: {
    files_changed: number;
    additions: number;
    deletions: number;
  };
};

// Re-exporting the canonical debrief type from jsonb keeps a single
// source of truth — the Zod schema validates the fixture at module
// load (see end of file) and will validate real debriefs in Slice 5.
export type MockedDebrief = DebriefContentT;

export type MockedSessionOutput = {
  debrief: MockedDebrief;
  diff: MockedDiff;
};

export const SAMPLE_DEPARTED_SPIRITS_OUTPUT: MockedSessionOutput = {
  debrief: {
    what_we_did:
      "Replaced the placeholder hero copy on the Departed Spirits landing page and " +
      "wired the CTA to /collections/seance-sips. Updated the meta description to " +
      "match the new positioning.",
    where_this_fits:
      "Final pre-launch polish before Friday's email blast. Sits directly in front " +
      "of the checkout funnel touched in last week's slice.",
    why_it_matters:
      "Open rate on the teaser was 31%; landing-page clarity is the next leak in the " +
      "funnel. The old hero copy still referred to a discontinued product.",
    what_went_wrong_or_next:
      "Lighthouse flagged a 320 KB hero image; ran out of slice budget before the " +
      "AVIF conversion. Next session: media pipeline + add picture sizes.",
    new_concept: {
      title: "Funnel-stage commit messages",
      body:
        "Tagging commits with funnel stage (`awareness:`, `consideration:`, …) " +
        "would let us audit which leaks each slice closes. Worth a Bilby plan.",
    },
  },
  diff: {
    files: [
      {
        path: "app/(marketing)/page.tsx",
        status: "modified",
        additions: 18,
        deletions: 6,
        patch: null,
      },
      {
        path: "components/marketing/hero.tsx",
        status: "modified",
        additions: 9,
        deletions: 11,
        patch: null,
      },
      {
        path: "components/marketing/cta.tsx",
        status: "added",
        additions: 24,
        deletions: 0,
        patch: null,
      },
      {
        path: "app/layout-meta-fallback.tsx",
        status: "deleted",
        additions: 0,
        deletions: 14,
        patch: null,
      },
    ],
    totals: { files_changed: 4, additions: 51, deletions: 31 },
  },
};

// Parse the fixture against the canonical schema at module load.
// Drift between the sample and DebriefContent surfaces as a load-time
// throw rather than a silent UI bug.
DebriefContent.parse(SAMPLE_DEPARTED_SPIRITS_OUTPUT.debrief);

/**
 * Returns the mocked SDK output for a given session. In Slice 3 every
 * `awaiting_review` session resolves to the same sample (the review
 * UI is what matters here, not per-session content). Slice 4 replaces
 * this with a real parse of the session's worktree via
 * `lib/feathertail/diff.ts` + the Opus debrief.
 */
export function getMockedOutputForSession(
  _session: Session,
): MockedSessionOutput {
  return SAMPLE_DEPARTED_SPIRITS_OUTPUT;
}
