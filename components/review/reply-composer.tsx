"use client";

// Reply composer for Redirect. Mounted by ActionBar only while in the
// "redirect" sub-flow. Submits POST /api/sessions/[id]/decisions with
// type="redirect", which writes a `decisions` row carrying
// payload.reply_text. The session row is intentionally unchanged
// (plan §8 Q1 = A), so no realtime UPDATE fires — UI confirmation is
// the form's return to its closed state.
//
// Skill chips append `prompt_template` to the textarea (each chip
// adds a fresh `\n\n`-separated block, so successive chips stack
// rather than overwrite). On append the textarea is focused and
// scrolled to its bottom — the operator sees the new content and
// the cursor lands ready for further edits.

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Skill } from "@/lib/types/db";

export function ReplyComposer({
  sessionId,
  skills,
  onClose,
}: {
  sessionId: string;
  skills: readonly Skill[];
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [inFlight, setInFlight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const trimmed = text.trim();
  const canSubmit = trimmed.length > 0 && !inFlight;

  const appendSkill = (template: string) => {
    setText((prev) => (prev.length === 0 ? template : `${prev}\n\n${template}`));
    // Defer focus/scroll to the next tick so the textarea has the new
    // value rendered before we read scrollHeight.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.scrollTop = el.scrollHeight;
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  const submit = async () => {
    if (!canSubmit) return;
    setInFlight(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "redirect",
          payload: { type: "redirect", reply_text: trimmed },
        }),
      });
      if (!res.ok) {
        let msg = `Request failed: ${res.status} ${res.statusText}`;
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body.error === "string") msg = body.error;
        } catch {
          // non-JSON body — keep fallback
        }
        setError(msg);
        setInFlight(false);
        return;
      }
      setText("");
      setInFlight(false);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      setError(msg);
      setInFlight(false);
    }
  };

  return (
    <div className="w-full space-y-3">
      <Textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What needs changing?"
        rows={3}
        disabled={inFlight}
        className="w-full min-h-[6rem] md:min-h-[8rem] [field-sizing:content]"
        aria-label="Redirect reply"
      />
      {skills.length > 0 && (
        <div
          className="flex flex-wrap gap-2"
          aria-label="Quick-move skill templates"
        >
          {skills.map((skill) => (
            <button
              key={skill.id}
              type="button"
              onClick={() => appendSkill(skill.prompt_template)}
              disabled={inFlight}
              title={skill.description ?? skill.prompt_template}
              className="rounded-full border border-border bg-muted px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {skill.name}
            </button>
          ))}
        </div>
      )}
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
          onClick={onClose}
          disabled={inFlight}
          className="w-full md:w-auto"
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="w-full md:w-auto"
        >
          {inFlight ? "Sending…" : "Send reply"}
        </Button>
      </div>
    </div>
  );
}
