import { describe, expect, it } from "vitest";

import { buildSliceName } from "@/lib/orchestration/create-session";

// Pure-helper tests for the §0b slug-prefix guard. The seed-mock-sessions
// script wipes rows matching `mock-%` or `fixture-%` (lib/supabase/
// seed-mock-sessions.ts:195-198); briefs starting with "Mock" or
// "Fixture" would otherwise produce real sessions that get clobbered.
// The guard prepends `r-` to defang both prefixes.

describe("buildSliceName — §0b reserved-prefix guard", () => {
  // Fixed suffix passed explicitly so the assertion is on the slug
  // portion only — randomSuffix is irrelevant to the guard's behaviour.
  const suffix = "a1b2c3";

  it("rewrites a 'Mock the…' brief to start with r-mock-", () => {
    const name = buildSliceName("Mock the API endpoint", suffix);
    expect(name).toBe(`r-mock-the-api-endpoint-${suffix}`);
    expect(name.startsWith("mock-")).toBe(false);
    expect(name.startsWith("fixture-")).toBe(false);
  });

  it("rewrites a 'Fixture this thing' brief to start with r-fixture-", () => {
    const name = buildSliceName("Fixture this thing", suffix);
    expect(name).toBe(`r-fixture-this-thing-${suffix}`);
    expect(name.startsWith("mock-")).toBe(false);
    expect(name.startsWith("fixture-")).toBe(false);
  });

  it("leaves a plain 'Fix a typo' brief unchanged (no collision)", () => {
    const name = buildSliceName("Fix a typo in the footer", suffix);
    expect(name).toBe(`fix-a-typo-in-the-footer-${suffix}`);
  });

  it("leaves a 'Reorganize…' brief unchanged (slug doesn't match either prefix)", () => {
    const name = buildSliceName("Reorganize the decisions log", suffix);
    expect(name).toBe(`reorganize-the-decisions-log-${suffix}`);
  });

  it("rewrites case-insensitively — 'MOCK something' slugifies to mock-... and is then guarded", () => {
    // slugify lowercases first, so "MOCK something" → "mock-something" →
    // guard applies → "r-mock-something".
    const name = buildSliceName("MOCK something important", suffix);
    expect(name).toBe(`r-mock-something-important-${suffix}`);
  });

  it("does NOT rewrite when 'mock' is embedded mid-string", () => {
    // "Improve the mock data" slugifies to "improve-the-mock-data" —
    // doesn't START with mock-, so no rewrite.
    const name = buildSliceName("Improve the mock data harness", suffix);
    expect(name).toBe(`improve-the-mock-data-harness-${suffix}`);
  });

  it("falls back gracefully when the brief slugifies to empty", () => {
    // All-special-character briefs slugify to "". The result is just
    // `-<suffix>`. Not a guard concern but worth pinning the behaviour.
    const name = buildSliceName("!!!", suffix);
    expect(name).toBe(`-${suffix}`);
  });
});
