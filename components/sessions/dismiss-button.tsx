"use client";

// Client-side dismiss/undismiss button island for SessionCard. Mounts
// when SessionCard's server-shell sees `affordances.dismiss ||
// affordances.undismiss` is true; the button itself decides which of
// the two actions it represents from the affordances prop. Mutually
// exclusive by construction — `dismiss` and `undismiss` can't both be
// true on the same row (one requires `dismissed_at IS NULL`, the
// other requires `IS NOT NULL`).
//
// POSTs to /api/sessions/[sessionId]/decisions with payload.session_label
// populated from session.slice_name (snapshot-at-decision-insert per the
// step-1 contract). Label-suffix loading pattern matches ActionBar
// ("Dismissing…" / "Un-dismissing…").
//
// Confirmed rendering: no optimistic UI. On success, the realtime
// SessionStatusSubscriber fires on the dismissed_at UPDATE, the page
// refreshes, the row drops out of the default-filter list (or
// reappears under "show dismissed"). Latency is one realtime round-
// trip; acceptable per docs/decisions/0009-slice-5-...md Stage 3.

import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { SessionAffordances } from "@/lib/orchestration/affordances";
import type { Session } from "@/lib/types/db";

export function DismissButton({
  session,
  affordances,
}: {
  session: Session;
  affordances: SessionAffordances;
}) {
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mutually exclusive by the affordances helper's construction. If
  // both somehow read true (impossible per the rules), prefer dismiss
  // — that's the "do something" affordance over the "undo something"
  // affordance.
  const action: "dismiss" | "undismiss" | null = affordances.dismiss
    ? "dismiss"
    : affordances.undismiss
      ? "undismiss"
      : null;
  if (action === null) return null;

  const submit = async () => {
    setInFlight(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${session.id}/decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: action,
          payload: {
            type: action,
            // Snapshot capture per step-1 contract — populated at
            // decision-insert time from the current slice_name.
            session_label: session.slice_name,
          },
        }),
      });
      if (!res.ok) {
        let msg = `Request failed: ${res.status} ${res.statusText}`;
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body.error === "string") msg = body.error;
        } catch {
          // non-JSON — keep fallback
        }
        setError(msg);
        setInFlight(false);
        return;
      }
      // Success — wait for the realtime UPDATE to refresh the page.
      // No local optimistic state; row leaves the default list view
      // when SessionStatusSubscriber sees the dismissed_at change.
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      setError(msg);
      setInFlight(false);
    }
  };

  const label =
    action === "dismiss"
      ? inFlight
        ? "Dismissing…"
        : "Dismiss"
      : inFlight
        ? "Un-dismissing…"
        : "Un-dismiss";

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={(e) => {
          // SessionCard wraps the textual content in a <Link>; this
          // button is a sibling of that Link but inside the same Card
          // container. Block the click from bubbling to anything that
          // might navigate.
          e.stopPropagation();
          void submit();
        }}
        disabled={inFlight}
        aria-label={action === "dismiss" ? "Dismiss session" : "Un-dismiss session"}
      >
        {label}
      </Button>
      {error && (
        <p
          role="alert"
          className="text-xs"
          style={{ color: "var(--color-coral)" }}
        >
          {error}
        </p>
      )}
    </>
  );
}
