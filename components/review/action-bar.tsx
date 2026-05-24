"use client";

// Status-aware review action bar. Mounts whenever
// `shouldMountActionBar(affordances)` is true (approve || redirect ||
// kill) — Slice 5 step 4b widened this from the awaiting_review-only
// mount to any non-terminal-non-dismissed session that has at least
// one of the three review actions available.
//
// Buttons render conditionally per the affordances record; the sub-flow
// state machine for the inline confirm / composer is unchanged. Submit
// path is POST /api/sessions/[sessionId]/decisions with payload built
// from local state plus the session_label snapshot for the step-1
// audit-preservation contract.
//
// V1 trim: dismiss/undismiss don't render here. They're list-only per
// docs/decisions/0009-slice-5-...md §D — the detail-page bar surfaces
// only the three review actions. The DismissButton island on
// SessionCard handles those.
//
// On a successful Approve / Kill the parent session row flips terminal;
// the page's SessionStatusSubscriber sees the realtime UPDATE and calls
// router.refresh(), at which point the RSC re-renders, the affordances
// recompute (approve/redirect/kill all false on terminal), and this
// component unmounts via the page's shouldMountActionBar gate. Redirect
// intentionally does NOT change session state (plan §8 Q1 = A) — the
// composer just clears and the sub-flow closes.
//
// 375px: action row stacks vertical; each button is w-full. md+: row,
// right-aligned, primary at the right edge.

import { useState } from "react";

import { ReplyComposer } from "@/components/review/reply-composer";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { SessionAffordances } from "@/lib/orchestration/affordances";
import type { Session, Skill } from "@/lib/types/db";

type Mode = "none" | "approve" | "redirect" | "kill";

type SubmitArgs =
  | { type: "approve"; note?: string }
  | { type: "kill"; reason: string };

export function ActionBar({
  session,
  skills,
  affordances,
}: {
  session: Session;
  skills: readonly Skill[];
  affordances: SessionAffordances;
}) {
  const [mode, setMode] = useState<Mode>("none");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setMode("none");
    setNote("");
    setReason("");
    setError(null);
  };

  const submit = async (args: SubmitArgs) => {
    setInFlight(true);
    setError(null);
    try {
      // Snapshot capture per step-1 contract — populated at decision-
      // insert time from the current slice_name. Identical pattern to
      // the DismissButton island.
      const sessionLabel = session.slice_name;
      const payload =
        args.type === "approve"
          ? args.note
            ? { type: "approve" as const, note: args.note, session_label: sessionLabel }
            : { type: "approve" as const, session_label: sessionLabel }
          : { type: "kill" as const, reason: args.reason, session_label: sessionLabel };
      const res = await fetch(`/api/sessions/${session.id}/decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: args.type, payload }),
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
      // Success: the session row flips terminal (or stays at the same
      // state for redirect), realtime UPDATE fires, page refreshes,
      // affordances recompute, this component re-renders or unmounts
      // per shouldMountActionBar. Don't reset state — the re-render
      // cleans up.
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      setError(msg);
      setInFlight(false);
    }
  };

  if (mode === "redirect") {
    return (
      <ReplyComposer
        sessionId={session.id}
        skills={skills}
        onClose={reset}
      />
    );
  }

  if (mode === "approve") {
    return (
      <div className="w-full space-y-3">
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note (e.g. 'shipped on Friday')"
          rows={2}
          disabled={inFlight}
          className="w-full [field-sizing:content]"
          aria-label="Approve note (optional)"
        />
        {error && (
          <p
            role="alert"
            className="text-sm"
            style={{ color: "var(--color-coral)" }}
          >
            {error}
          </p>
        )}
        <div className="flex flex-col gap-2 md:flex-row md:justify-end">
          <Button
            type="button"
            variant="ghost"
            onClick={reset}
            disabled={inFlight}
            className="w-full md:w-auto"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() =>
              void submit({
                type: "approve",
                note: note.trim() || undefined,
              })
            }
            disabled={inFlight}
            className="w-full md:w-auto"
          >
            {inFlight ? "Approving…" : "Confirm approve"}
          </Button>
        </div>
      </div>
    );
  }

  if (mode === "kill") {
    const trimmed = reason.trim();
    const canKill = trimmed.length > 0 && !inFlight;
    return (
      <div className="w-full space-y-3">
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why are you killing this session?"
          rows={2}
          disabled={inFlight}
          className="w-full [field-sizing:content]"
          aria-label="Kill reason (required)"
        />
        {error && (
          <p
            role="alert"
            className="text-sm"
            style={{ color: "var(--color-coral)" }}
          >
            {error}
          </p>
        )}
        <div className="flex flex-col gap-2 md:flex-row md:justify-end">
          <Button
            type="button"
            variant="ghost"
            onClick={reset}
            disabled={inFlight}
            className="w-full md:w-auto"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void submit({ type: "kill", reason: trimmed })}
            disabled={!canKill}
            className="w-full md:w-auto"
          >
            {inFlight ? "Killing…" : "Confirm kill"}
          </Button>
        </div>
      </div>
    );
  }

  // mode === "none" — render the affordances-driven button row.
  return (
    <div className="flex flex-col gap-2 md:flex-row md:justify-end md:gap-3">
      {affordances.kill && (
        <Button
          type="button"
          variant="ghost"
          onClick={() => setMode("kill")}
          className="w-full md:w-auto"
        >
          Kill
        </Button>
      )}
      {affordances.redirect && (
        <Button
          type="button"
          variant="secondary"
          onClick={() => setMode("redirect")}
          className="w-full md:w-auto"
        >
          Redirect
        </Button>
      )}
      {affordances.approve && (
        <Button
          type="button"
          onClick={() => setMode("approve")}
          className="w-full md:w-auto"
        >
          Approve
        </Button>
      )}
    </div>
  );
}
