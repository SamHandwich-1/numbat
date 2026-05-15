"use client";

// Three-button review action bar. Owns the local sub-flow state —
// which of {none, approve-confirm, redirect-composer, kill-confirm}
// is currently open. Approve and Kill use small inline confirms
// (Approve's note is optional; Kill's reason is required). Redirect
// reveals the ReplyComposer.
//
// On a successful Approve / Kill the parent session row flips
// terminal; the page's SessionStatusSubscriber sees the realtime
// UPDATE and calls router.refresh(), at which point the RSC re-
// renders with the read-only banner and this component unmounts.
// Redirect intentionally does NOT change session state (plan §8
// Q1 = A) — the composer just clears and the sub-flow closes.
//
// 375px: action row stacks vertical; each button is w-full. md+:
// row, right-aligned, primary at the right edge.

import { useState } from "react";

import { ReplyComposer } from "@/components/review/reply-composer";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Skill } from "@/lib/types/db";

type Mode = "none" | "approve" | "redirect" | "kill";

type SubmitArgs =
  | { type: "approve"; note?: string }
  | { type: "kill"; reason: string };

export function ActionBar({
  sessionId,
  skills,
}: {
  sessionId: string;
  skills: readonly Skill[];
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
      const payload =
        args.type === "approve"
          ? args.note
            ? { type: "approve" as const, note: args.note }
            : { type: "approve" as const }
          : { type: "kill" as const, reason: args.reason };
      const res = await fetch(`/api/sessions/${sessionId}/decisions`, {
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
      // Success: the session row flips terminal, realtime UPDATE fires,
      // page refreshes, this component unmounts. Don't reset state —
      // the unmount cleans up.
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      setError(msg);
      setInFlight(false);
    }
  };

  if (mode === "redirect") {
    return (
      <ReplyComposer
        sessionId={sessionId}
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

  // mode === "none"
  return (
    <div className="flex flex-col gap-2 md:flex-row md:justify-end md:gap-3">
      <Button
        type="button"
        variant="ghost"
        onClick={() => setMode("kill")}
        className="w-full md:w-auto"
      >
        Kill
      </Button>
      <Button
        type="button"
        variant="secondary"
        onClick={() => setMode("redirect")}
        className="w-full md:w-auto"
      >
        Redirect
      </Button>
      <Button
        type="button"
        onClick={() => setMode("approve")}
        className="w-full md:w-auto"
      >
        Approve
      </Button>
    </div>
  );
}
