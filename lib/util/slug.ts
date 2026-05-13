// Slug + random-suffix helpers for stable identifiers (slice_name in
// 2b's createSession; worktree path segments in slice 4's Feathertail).
// Kept here rather than colocated with createSession because slice 4
// will need slugify when it constructs `~/numbat-worktrees/<project-slug>/
// <slice-name>/`. One source, two consumers.

/**
 * Lowercase, replace runs of non-alphanumeric chars with '-', trim
 * leading/trailing dashes.
 *
 * Example: `slugify("Fix typo in footer!") === "fix-typo-in-footer"`
 *
 * Doesn't normalise Unicode — the input is operator-typed English.
 * If a brief is all special chars (rare in practice), the result is
 * the empty string and the caller's suffix saves the slice_name from
 * being just "-".
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Random base36 suffix of the requested length. Matches the pattern
 * already used in lib/supabase/test-fixtures.ts (Math.random + base36).
 *
 * Math.random is fine here — collision-resistance is the only goal,
 * not unpredictability. 36^6 = ~2.18B values is comfortable for V1
 * single-operator volumes (low hundreds of sessions/year).
 *
 * The while loop guards against the rare case where Math.random
 * returns a small enough value that toString(36).slice(2) yields
 * fewer than `length` chars.
 */
export function randomSuffix(length: number = 6): string {
  let s = "";
  while (s.length < length) {
    s += Math.random().toString(36).slice(2);
  }
  return s.slice(0, length);
}
