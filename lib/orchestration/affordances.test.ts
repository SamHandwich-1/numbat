import { describe, expect, it } from "vitest";

import {
  deriveSessionAffordances,
  shouldMountActionBar,
  shouldMountDismissButton,
  type SessionAffordances,
} from "@/lib/orchestration/affordances";
import type { SessionStatus } from "@/lib/types/db";

// SYNC: the rules in this test (and the helper it tests) mirror the
// guards in lib/supabase/mutations/decisions.ts's recordDecision. If
// either set of rules changes, both must update together. See the
// Slice 5 close-out's carry-list for the consolidation plan.
//
// Table-driven: every (status, dismissed_at) combination as an
// explicit row. Adding a new status to the schema will surface here
// as an obvious table extension.

const DISMISSED_AT_VALUE = "2026-05-24T10:00:00.000Z";

type Row = {
  status: SessionStatus;
  dismissed_at: string | null;
  expected: SessionAffordances;
};

const FALSE_ALL: SessionAffordances = {
  approve: false,
  redirect: false,
  kill: false,
  dismiss: false,
  undismiss: false,
};

const TABLE: readonly Row[] = [
  // idle — kill only (live worker or stuck spawn).
  {
    status: "idle",
    dismissed_at: null,
    expected: { ...FALSE_ALL, kill: true },
  },
  {
    status: "idle",
    dismissed_at: DISMISSED_AT_VALUE,
    expected: { ...FALSE_ALL, kill: true, undismiss: true },
  },

  // planning — reserved for Bilby flows that don't ship in Slice 5.
  {
    status: "planning",
    dismissed_at: null,
    expected: { ...FALSE_ALL },
  },
  {
    status: "planning",
    dismissed_at: DISMISSED_AT_VALUE,
    expected: { ...FALSE_ALL, undismiss: true },
  },

  // running — kill only.
  {
    status: "running",
    dismissed_at: null,
    expected: { ...FALSE_ALL, kill: true },
  },
  {
    status: "running",
    dismissed_at: DISMISSED_AT_VALUE,
    expected: { ...FALSE_ALL, kill: true, undismiss: true },
  },

  // awaiting_review — approve, redirect, kill all valid.
  {
    status: "awaiting_review",
    dismissed_at: null,
    expected: { ...FALSE_ALL, approve: true, redirect: true, kill: true },
  },
  {
    status: "awaiting_review",
    dismissed_at: DISMISSED_AT_VALUE,
    expected: {
      ...FALSE_ALL,
      approve: true,
      redirect: true,
      kill: true,
      undismiss: true,
    },
  },

  // blocked — kill and dismiss (per Step 0a §D's terminal cohort).
  {
    status: "blocked",
    dismissed_at: null,
    expected: { ...FALSE_ALL, kill: true, dismiss: true },
  },
  {
    status: "blocked",
    dismissed_at: DISMISSED_AT_VALUE,
    expected: { ...FALSE_ALL, kill: true, undismiss: true },
  },

  // done — dismiss only.
  {
    status: "done",
    dismissed_at: null,
    expected: { ...FALSE_ALL, dismiss: true },
  },
  {
    status: "done",
    dismissed_at: DISMISSED_AT_VALUE,
    expected: { ...FALSE_ALL, undismiss: true },
  },

  // killed — dismiss only.
  {
    status: "killed",
    dismissed_at: null,
    expected: { ...FALSE_ALL, dismiss: true },
  },
  {
    status: "killed",
    dismissed_at: DISMISSED_AT_VALUE,
    expected: { ...FALSE_ALL, undismiss: true },
  },

  // killing — transient, no actions until terminal write completes.
  {
    status: "killing",
    dismissed_at: null,
    expected: { ...FALSE_ALL },
  },
  {
    status: "killing",
    dismissed_at: DISMISSED_AT_VALUE,
    expected: { ...FALSE_ALL, undismiss: true },
  },
];

describe("deriveSessionAffordances", () => {
  for (const row of TABLE) {
    const dismissedLabel = row.dismissed_at === null ? "null" : "set";
    it(`${row.status} / dismissed_at=${dismissedLabel}`, () => {
      const result = deriveSessionAffordances({
        status: row.status,
        dismissed_at: row.dismissed_at,
      });
      expect(result).toEqual(row.expected);
    });
  }

  // Step 4b — render-branching predicates. Pure OR-logic over the
  // affordances record. The 16-row table above exercises the
  // affordances themselves; these focus on the call-site OR pattern.

  describe("shouldMountActionBar (detail-page predicate)", () => {
    it("true when approve is true (awaiting_review session)", () => {
      const a: SessionAffordances = {
        approve: true,
        redirect: true,
        kill: true,
        dismiss: false,
        undismiss: false,
      };
      expect(shouldMountActionBar(a)).toBe(true);
    });

    it("true when only kill is true (idle/running/blocked session)", () => {
      const a: SessionAffordances = {
        approve: false,
        redirect: false,
        kill: true,
        dismiss: false,
        undismiss: false,
      };
      expect(shouldMountActionBar(a)).toBe(true);
    });

    it("false on a terminal session (only dismiss/undismiss possible)", () => {
      const a: SessionAffordances = {
        approve: false,
        redirect: false,
        kill: false,
        dismiss: true,
        undismiss: false,
      };
      // V1 trim: dismiss is list-only, so the detail-page bar must NOT
      // mount on this affordance alone.
      expect(shouldMountActionBar(a)).toBe(false);
    });

    it("false when every affordance is false (killing / planning)", () => {
      const a: SessionAffordances = {
        approve: false,
        redirect: false,
        kill: false,
        dismiss: false,
        undismiss: false,
      };
      expect(shouldMountActionBar(a)).toBe(false);
    });
  });

  describe("shouldMountDismissButton (session-card island predicate)", () => {
    it("true when dismiss is true (terminal + not dismissed)", () => {
      const a: SessionAffordances = {
        approve: false,
        redirect: false,
        kill: true,
        dismiss: true,
        undismiss: false,
      };
      expect(shouldMountDismissButton(a)).toBe(true);
    });

    it("true when undismiss is true (any row with dismissed_at set)", () => {
      const a: SessionAffordances = {
        approve: false,
        redirect: false,
        kill: false,
        dismiss: false,
        undismiss: true,
      };
      expect(shouldMountDismissButton(a)).toBe(true);
    });

    it("false on awaiting_review (neither dismiss nor undismiss)", () => {
      const a: SessionAffordances = {
        approve: true,
        redirect: true,
        kill: true,
        dismiss: false,
        undismiss: false,
      };
      expect(shouldMountDismissButton(a)).toBe(false);
    });
  });

  // Sanity: the table covers every SessionStatus value (8) × both
  // dismissed_at states (2) = 16 rows. If a new SessionStatus value
  // is added without a row here, this assertion fails before the
  // production code reaches a missing case.
  it("table covers every (status, dismissed?) combination", () => {
    const ALL_STATUSES: readonly SessionStatus[] = [
      "idle",
      "planning",
      "running",
      "awaiting_review",
      "blocked",
      "done",
      "killed",
      "killing",
    ];
    expect(TABLE.length).toBe(ALL_STATUSES.length * 2);
    for (const status of ALL_STATUSES) {
      const rowsForStatus = TABLE.filter((r) => r.status === status);
      expect(rowsForStatus.length).toBe(2);
      expect(rowsForStatus.some((r) => r.dismissed_at === null)).toBe(true);
      expect(rowsForStatus.some((r) => r.dismissed_at !== null)).toBe(true);
    }
  });
});
