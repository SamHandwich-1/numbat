// Australia/Melbourne timezone helpers. Lives in lib/time/ rather than
// alongside the server queries because client components need this
// without dragging lib/supabase/server.ts into their bundle. server.ts
// has a runtime browser-load throw guard — even when the bundler
// tree-shakes the actual sbAdmin reference, the guard string lands in
// the client chunk and crashes module load.
//
// Shared between server callers (lib/supabase/queries/sessions.ts:
// getTodayCostUsd) and client callers (components/shared/cost-badge.tsx,
// step 14 realtime-INSERT filter). DO NOT duplicate.
//
// V1 single-operator assumption: the operator works in Melbourne local
// time. Revisit when V2 introduces multi-user — each user's "today"
// will be their own timezone.

/**
 * The UTC ISO timestamp corresponding to today's local midnight in
 * Melbourne. Used as the lower bound for "today's spend" cost queries.
 *
 * Iterative DST-aware solver. The simpler approach (compute Melbourne's
 * UTC offset at UTC midnight, subtract from candidate) is wrong by 1
 * hour on DST transition days — Melbourne midnight falls before the
 * 02:00 transition but the offset query at UTC midnight returns the
 * post-transition value. Iterative because cost data must reconcile
 * against Anthropic/xAI's UTC billing exactly, not approximately.
 * Converges in 1 iteration normally, 2 on DST transitions, capped at 3.
 */
export function melbourneTodayStartUtcIso(): string {
  const tz = "Australia/Melbourne";
  const now = new Date();

  // Step 1: today's date in Melbourne, as YYYY-MM-DD.
  const todayMelb = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  // Step 2: find the UTC instant U such that U formatted in Melbourne
  // reads "todayMelb 00:00:00".
  const fullFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const wallTargetMs = new Date(`${todayMelb}T00:00:00Z`).getTime();
  let utcMs = wallTargetMs;
  for (let i = 0; i < 3; i++) {
    const parts = fullFmt.formatToParts(new Date(utcMs));
    const part = (t: string): number =>
      Number(parts.find((p) => p.type === t)?.value ?? 0);
    const wallAtCandidateMs = Date.UTC(
      part("year"),
      part("month") - 1,
      part("day"),
      part("hour"),
      part("minute"),
      part("second"),
    );
    const driftMs = wallAtCandidateMs - wallTargetMs;
    if (driftMs === 0) break;
    utcMs -= driftMs;
  }
  return new Date(utcMs).toISOString();
}

/**
 * True if the given UTC ISO timestamp falls on or after today's local
 * midnight in Melbourne. Used by the cost badge's realtime handler to
 * filter INSERTs to today's rows.
 *
 * Re-evaluates the boundary on every call rather than caching it, so
 * the cost badge naturally drops yesterday's tail events once Melbourne
 * ticks past midnight without needing to re-subscribe.
 */
export function isMelbourneToday(iso: string): boolean {
  return (
    new Date(iso).getTime() >= new Date(melbourneTodayStartUtcIso()).getTime()
  );
}
