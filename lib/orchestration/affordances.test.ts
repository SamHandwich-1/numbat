import { describe, expect, it } from "vitest";

import {
  deriveSessionAffordances,
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
