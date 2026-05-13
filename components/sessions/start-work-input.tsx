"use client";

// Start Work form. Mounted at the top of /sessions in step 13.
// Operator picks a project, types a brief, submits — POST to
// /api/start-work which routes the brief, creates the artifact,
// and returns a redirect URL. This component navigates there and
// unmounts.
//
// State invariants:
//   - projectId persists to localStorage["numbat:last_project_id"]
//     so a fresh form defaults to the previous project. Cleared
//     by /login on every cookie-set (step 11c) — no cleanup here.
//   - On mount, the saved id is validated against the current
//     projects prop; a stale id (project deleted) is dropped
//     silently, leaving the form in its empty initial state.
//
// Submit affordances:
//   - Visible "Start work" Button (form submit)
//   - Cmd+Enter / Ctrl+Enter from inside the textarea
//   - Bare Enter is the default textarea newline — NOT a submit.
//     Submit-on-Enter is too easy to fire accidentally on a
//     multi-line brief.

import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { Project } from "@/lib/types/db";

const LAST_PROJECT_KEY = "numbat:last_project_id";

// Only the field this component reads — the response also carries
// pipeline + matched_rule, useful for future "you were routed to X"
// UI but not consumed here.
type StartWorkResponse = { redirect_url: string };

export function StartWorkInput({ projects }: { projects: Project[] }) {
  const router = useRouter();
  const [projectId, setProjectId] = useState<string>("");
  const [brief, setBrief] = useState<string>("");
  const [inFlight, setInFlight] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Hydrate projectId from localStorage on mount; validate against
  // the current projects list so a deleted project doesn't sit in
  // the form as a non-selectable id.
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(LAST_PROJECT_KEY);
    } catch {
      // private mode / strict storage — fail silent
    }
    if (!saved) return;
    if (projects.some((p) => p.id === saved)) {
      setProjectId(saved);
    } else {
      try {
        localStorage.removeItem(LAST_PROJECT_KEY);
      } catch {
        // fail silent
      }
    }
  }, [projects]);

  // Persist projectId on change. Skip the empty-string initial
  // state so we don't overwrite a previously-saved id with "".
  useEffect(() => {
    if (!projectId) return;
    try {
      localStorage.setItem(LAST_PROJECT_KEY, projectId);
    } catch {
      // fail silent
    }
  }, [projectId]);

  const trimmed = brief.trim();
  const isValid = projectId !== "" && trimmed.length > 0;
  const canSubmit = isValid && !inFlight;

  const submit = async () => {
    if (!canSubmit) return;
    setInFlight(true);
    setError(null);
    try {
      const res = await fetch("/api/start-work", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Same-origin fetch — cookies (numbat_auth) are sent
        // automatically; no manual auth header needed.
        body: JSON.stringify({ projectId, brief: trimmed }),
      });
      if (!res.ok) {
        // Try to parse { error: string } from the body; fall back
        // to a generic message with status text. Don't crash the
        // form on a malformed (non-JSON) error response.
        let msg = `Request failed: ${res.status} ${res.statusText}`;
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body.error === "string") msg = body.error;
        } catch {
          // Non-JSON body (HTML error page, network proxy, etc.);
          // keep the status-text fallback.
        }
        setError(msg);
        setInFlight(false);
        return;
      }
      const body = (await res.json()) as StartWorkResponse;
      // redirect_url is a runtime string — typedRoutes can't verify
      // it statically. Same `as Route` pattern as app/page.tsx and
      // the filter components.
      router.push(body.redirect_url as Route);
      // Don't reset inFlight — the component unmounts on navigation.
    } catch (err) {
      // Network failure (fetch threw before getting a response).
      const msg = err instanceof Error ? err.message : "Something went wrong";
      setError(msg);
      setInFlight(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="flex flex-col gap-3"
    >
      <Select
        value={projectId}
        onValueChange={setProjectId}
        disabled={inFlight}
      >
        <SelectTrigger
          className="w-full sm:w-[240px]"
          aria-label="Project for new session"
        >
          <SelectValue placeholder="Pick a project" />
        </SelectTrigger>
        <SelectContent>
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.short_code} · {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Textarea
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder="What needs work?"
        rows={2}
        disabled={inFlight}
        // [field-sizing:content] auto-resizes the textarea to its
        // content (Chrome 123+, Firefox 122+, Safari 17.4+). On
        // older browsers the property is ignored and min-h-[3.5rem]
        // keeps a sensible floor with default scrolling past it.
        className="w-full min-h-[3.5rem] [field-sizing:content]"
      />

      {error && (
        <p
          className="text-sm"
          style={{ color: "var(--color-coral)" }}
          role="alert"
        >
          {error}
        </p>
      )}

      <div className="flex justify-end">
        <Button
          type="submit"
          disabled={!canSubmit}
          className="w-full sm:w-auto"
        >
          {inFlight ? "Routing…" : "Start work"}
        </Button>
      </div>
    </form>
  );
}
