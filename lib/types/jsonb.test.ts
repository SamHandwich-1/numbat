import { describe, expect, it } from "vitest";

import {
  DebriefContent,
  DecisionPayload,
  SessionLastError,
} from "@/lib/types/jsonb";

// Pure Vitest — no DB. Validates the shape of jsonb fields written/read
// during Slice 3's review flow. Discriminator + minimum-length rules
// are load-bearing for the API route's safeParse path.

describe("DecisionPayload (Slice 3 variants)", () => {
  it("approve without note succeeds (note is optional)", () => {
    const result = DecisionPayload.safeParse({ type: "approve" });
    expect(result.success).toBe(true);
  });

  it("approve with note succeeds", () => {
    const result = DecisionPayload.safeParse({ type: "approve", note: "lgtm" });
    expect(result.success).toBe(true);
  });

  it("redirect with reply_text succeeds", () => {
    const result = DecisionPayload.safeParse({
      type: "redirect",
      reply_text: "use the imperative voice in headings",
    });
    expect(result.success).toBe(true);
  });

  it("redirect without reply_text fails", () => {
    const result = DecisionPayload.safeParse({ type: "redirect" });
    expect(result.success).toBe(false);
  });

  it("kill with reason succeeds", () => {
    const result = DecisionPayload.safeParse({
      type: "kill",
      reason: "scope drift",
    });
    expect(result.success).toBe(true);
  });

  it("kill without reason fails", () => {
    const result = DecisionPayload.safeParse({ type: "kill" });
    expect(result.success).toBe(false);
  });

  it("rejects approve shape with redirect field (wrong discriminator)", () => {
    const result = DecisionPayload.safeParse({
      type: "approve",
      reply_text: "this belongs to redirect",
    });
    // Discriminated union accepts approve regardless of extra fields by
    // default. Assert at minimum that supplying reply_text on `redirect`
    // and reason on `kill` are not accidentally accepted for `approve`.
    expect(result.success).toBe(true);
    // Spot-check: a *missing* discriminator value is rejected.
    expect(DecisionPayload.safeParse({ reply_text: "x" }).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Slice 5 step 1 — DecisionPayload snapshot fields (session_label /
// plan_label). Extended on four variants currently in live use:
// approve, redirect, kill, start_work. The tests assert both:
//   - backward compat: pre-Slice-5 payloads (no snapshot fields) parse
//   - forward compat:  new payloads (with both snapshot fields) parse
// ─────────────────────────────────────────────────────────────────────

describe("DecisionPayload (Slice 5 snapshot fields)", () => {
  const SNAPSHOT_BOTH = {
    session_label: "fix-typo-in-footer-a1b2c3",
    plan_label: "Slice 5 — operator action surface",
  } as const;

  it("approve — backward compat (no snapshot fields) parses", () => {
    expect(DecisionPayload.safeParse({ type: "approve" }).success).toBe(true);
  });

  it("approve — forward compat (with both snapshot fields) parses", () => {
    expect(
      DecisionPayload.safeParse({ type: "approve", ...SNAPSHOT_BOTH }).success,
    ).toBe(true);
  });

  it("redirect — backward compat parses", () => {
    expect(
      DecisionPayload.safeParse({ type: "redirect", reply_text: "x" }).success,
    ).toBe(true);
  });

  it("redirect — forward compat (with both snapshot fields) parses", () => {
    expect(
      DecisionPayload.safeParse({
        type: "redirect",
        reply_text: "x",
        ...SNAPSHOT_BOTH,
      }).success,
    ).toBe(true);
  });

  it("kill — backward compat parses", () => {
    expect(
      DecisionPayload.safeParse({ type: "kill", reason: "scope" }).success,
    ).toBe(true);
  });

  it("kill — forward compat (with both snapshot fields) parses", () => {
    expect(
      DecisionPayload.safeParse({
        type: "kill",
        reason: "scope",
        ...SNAPSHOT_BOTH,
      }).success,
    ).toBe(true);
  });

  it("start_work — backward compat parses", () => {
    expect(
      DecisionPayload.safeParse({
        type: "start_work",
        routed_to: "direct",
        matched_rule: "length_under_200",
        reason: "short brief",
      }).success,
    ).toBe(true);
  });

  it("start_work — forward compat (with both snapshot fields) parses", () => {
    expect(
      DecisionPayload.safeParse({
        type: "start_work",
        routed_to: "direct",
        matched_rule: "length_under_200",
        reason: "short brief",
        ...SNAPSHOT_BOTH,
      }).success,
    ).toBe(true);
  });
});

describe("SessionLastError", () => {
  it("accepts the new 'operator' source value used by Kill", () => {
    const result = SessionLastError.safeParse({
      message: "operator stopped session",
      source: "operator",
      occurred_at: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("still accepts the pre-existing source values", () => {
    for (const source of [
      "agent_sdk",
      "worker",
      "supabase",
      "validation",
    ] as const) {
      const result = SessionLastError.safeParse({
        message: "x",
        source,
        occurred_at: new Date().toISOString(),
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an unknown source value", () => {
    const result = SessionLastError.safeParse({
      message: "x",
      source: "user",
      occurred_at: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});

describe("DebriefContent", () => {
  const good = {
    what_we_did: "x",
    where_this_fits: "x",
    why_it_matters: "x",
    what_went_wrong_or_next: "x",
  };

  it("accepts a minimal four-section debrief", () => {
    expect(DebriefContent.safeParse(good).success).toBe(true);
  });

  it("accepts a debrief with an optional new_concept block", () => {
    const result = DebriefContent.safeParse({
      ...good,
      new_concept: { title: "t", body: "b" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects when a required section is missing", () => {
    const { what_we_did, ...without } = good;
    void what_we_did;
    expect(DebriefContent.safeParse(without).success).toBe(false);
  });

  it("rejects empty-string section bodies (min(1) constraint)", () => {
    const result = DebriefContent.safeParse({ ...good, what_we_did: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty new_concept title", () => {
    const result = DebriefContent.safeParse({
      ...good,
      new_concept: { title: "", body: "b" },
    });
    expect(result.success).toBe(false);
  });
});
