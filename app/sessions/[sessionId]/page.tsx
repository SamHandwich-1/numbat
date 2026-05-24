// Single-session detail / review page.
//
// Slice 4 composition (Option A — real diff, mocked debrief):
//   - DIFF field: read from session.diff (jsonb, written by the worker
//     on transition to awaiting_review). Validated through the
//     WorktreeDiff Zod schema at the boundary so a drift between the
//     persisted shape and the consuming component surfaces as a parse
//     error rather than a silent UI bug. null → empty-diff state.
//   - DEBRIEF field: still from getMockedOutputForSession (mock).
//     Slice 5 wires the real Opus debrief.
//
// Status-driven branching:
//   awaiting_review              → header + debrief + real diff + <ActionBar/>
//   done / killed                → header + debrief + real diff + TerminalBanner
//   killing (transient)          → "Stopping…" placeholder (Slice 4 two-phase
//                                  kill — worker is tearing down the SDK; the
//                                  realtime subscriber will refresh when status
//                                  flips to 'killed')
//   idle / planning / running /
//   blocked                      → NotReadyPlaceholder
//
// SessionStatusSubscriber mounts in every branch so a status change
// (worker writes, operator actions elsewhere) re-renders the page
// within ~1s.

import { notFound } from "next/navigation";

import { ActionBar } from "@/components/review/action-bar";
import { DebriefBlock } from "@/components/review/debrief-block";
import { DiffPreview } from "@/components/review/diff-preview";
import { SessionStatusSubscriber } from "@/components/review/session-status-subscriber";
import { ProjectChip } from "@/components/sessions/project-chip";
import { RelativeTime } from "@/components/sessions/relative-time";
import { getMockedOutputForSession } from "@/lib/mock/agent-sdk-output";
import {
  deriveSessionAffordances,
  shouldMountActionBar,
} from "@/lib/orchestration/affordances";
import { ContextLoader } from "@/lib/orchestration/context";
import { getSession } from "@/lib/supabase/queries/sessions";
import { sbAdmin } from "@/lib/supabase/server";
import { WorktreeDiff, type WorktreeDiffT } from "@/lib/types/jsonb";
import { STATUS_TO_TOKEN } from "@/lib/types/ui";

const TERMINAL_STATUSES = new Set(["done", "killed"]);

const EMPTY_DIFF: WorktreeDiffT = {
  files: [],
  totals: { files_changed: 0, additions: 0, deletions: 0 },
};

export default async function SessionDetailPage({
  params,
}: {
  // Next 15: params is a Promise.
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  const session = await getSession(sessionId);
  if (!session) notFound();

  // Project for the header chip. Single-row read — small enough to do
  // inline rather than introducing a queries/projects.ts module for
  // V1. (Slice 5 / 6 may want one once plan pages also need projects.)
  const { data: project, error: projectError } = await sbAdmin
    .from("projects")
    .select("*")
    .eq("id", session.project_id)
    .single();
  if (projectError) throw new Error(`session-page: project — ${projectError.message}`);
  if (!project) throw new Error(`session-page: project ${session.project_id} not found`);

  // ContextLoader is the project-scoping gate. It asserts the session
  // belongs to the project before loading skills; an inconsistency
  // here would surface as ContextLoaderCrossProjectError (a programming
  // bug, not an expected failure — bubble it up).
  const loader = new ContextLoader(sbAdmin);
  const ctx = await loader.buildFor(
    session.project_id,
    "session",
    session.id,
  );

  // Compose: real diff from session.diff (parsed at the boundary),
  // mock debrief from getMockedOutputForSession. The debrief mock is
  // Slice 5's loose end — see lib/mock/agent-sdk-output.ts header.
  const mock = getMockedOutputForSession(session);
  const realDiff: WorktreeDiffT =
    session.diff !== null ? WorktreeDiff.parse(session.diff) : EMPTY_DIFF;

  const statusVar = `var(${STATUS_TO_TOKEN[session.status]})`;
  const statusLabel = session.status.replace(/_/g, " ");

  // Slice 5 step 4b: mount the ActionBar based on the affordances helper
  // rather than a hardcoded status check. shouldMountActionBar covers
  // approve||redirect||kill — the three "review" actions. dismiss /
  // undismiss are deliberately NOT in the OR-list; they're list-only
  // affordances in V1 per docs/decisions/0009-slice-5-...md §D, and
  // surface only on the SessionCard's DismissButton island.
  const affordances = deriveSessionAffordances(session);
  const showActionBar = shouldMountActionBar(affordances);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
      <SessionStatusSubscriber sessionId={session.id} />

      <header className="flex flex-col gap-2 border-b border-border pb-4">
        <div className="flex items-center gap-2">
          <ProjectChip project={project} />
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: statusVar }}
            aria-hidden="true"
          />
          <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
            {statusLabel}
          </span>
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            <RelativeTime iso={session.updated_at} />
          </span>
        </div>
        <h1 className="font-display text-2xl italic">{session.slice_name}</h1>
        <p className="text-sm text-muted-foreground">{session.task}</p>
      </header>

      {session.status === "awaiting_review" || TERMINAL_STATUSES.has(session.status) ? (
        <>
          <DebriefBlock title="What we did" body={mock.debrief.what_we_did} />
          <DebriefBlock title="Where this fits" body={mock.debrief.where_this_fits} />
          <DebriefBlock title="Why it matters" body={mock.debrief.why_it_matters} />
          <DebriefBlock
            title="What went wrong / what's next"
            body={mock.debrief.what_went_wrong_or_next}
          />
          {mock.debrief.new_concept && (
            <DebriefBlock
              title={`New concept · ${mock.debrief.new_concept.title}`}
              body={mock.debrief.new_concept.body}
            />
          )}
          <DiffPreview diff={realDiff} />

          {TERMINAL_STATUSES.has(session.status) && (
            <TerminalBanner session={session} />
          )}
        </>
      ) : session.status === "killing" ? (
        <StoppingPlaceholder />
      ) : (
        <NotReadyPlaceholder statusLabel={statusLabel} />
      )}

      {showActionBar && (
        <ActionBar session={session} skills={ctx.skills} affordances={affordances} />
      )}
    </main>
  );
}

function StoppingPlaceholder() {
  return (
    <section
      className="rounded-md border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground"
      aria-live="polite"
    >
      <p className="font-mono uppercase tracking-wider">Stopping…</p>
      <p className="mt-2 text-xs">
        Operator kill received; waiting for the worker to confirm SDK teardown.
      </p>
    </section>
  );
}

function TerminalBanner({
  session,
}: {
  session: {
    status: string;
    completed_at: string | null;
    last_error: { message: string } | null;
  };
}) {
  if (session.status === "done") {
    return (
      <section
        className="rounded-md border border-border bg-card px-4 py-3 text-sm"
        aria-live="polite"
      >
        <span
          className="mr-2 font-mono text-xs uppercase tracking-wider"
          style={{ color: "var(--color-fg-dim)" }}
        >
          approved
        </span>
        {session.completed_at && (
          <span className="text-muted-foreground">
            <RelativeTime iso={session.completed_at} />
          </span>
        )}
      </section>
    );
  }
  // status === "killed"
  return (
    <section
      className="rounded-md border border-border bg-card px-4 py-3 text-sm"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <span
          className="font-mono text-xs uppercase tracking-wider"
          style={{ color: "var(--color-coral)" }}
        >
          killed
        </span>
        {session.completed_at && (
          <span className="ml-auto font-mono text-xs text-muted-foreground">
            <RelativeTime iso={session.completed_at} />
          </span>
        )}
      </div>
      {session.last_error?.message && (
        <p className="mt-2 break-words text-muted-foreground">
          {session.last_error.message}
        </p>
      )}
    </section>
  );
}

function NotReadyPlaceholder({ statusLabel }: { statusLabel: string }) {
  return (
    <section className="rounded-md border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
      This session is{" "}
      <span className="font-mono uppercase tracking-wider">{statusLabel}</span>{" "}
      and not yet ready for review.
    </section>
  );
}
