// Single-session detail / review page. Mocked Agent SDK output drives
// the debrief and diff in Slice 3 — Slice 4 swaps the mock for a real
// worktree parse + Opus debrief.
//
// Status-driven branching (plan §3a):
//   awaiting_review        → header + debrief + diff + <ActionBar/>
//   done / killed          → header + debrief + diff + read-only banner
//   idle / planning /
//   running / blocked      → header + "not yet ready for review" placeholder
//
// SessionStatusSubscriber mounts in every branch so a status change
// elsewhere (the operator approving in another tab, a future Slice 4
// worker flipping a session to awaiting_review, etc.) re-renders the
// page within ~1s.

import { notFound } from "next/navigation";

import { ActionBar } from "@/components/review/action-bar";
import { DebriefBlock } from "@/components/review/debrief-block";
import { DiffPreview } from "@/components/review/diff-preview";
import { SessionStatusSubscriber } from "@/components/review/session-status-subscriber";
import { ProjectChip } from "@/components/sessions/project-chip";
import { RelativeTime } from "@/components/sessions/relative-time";
import { getMockedOutputForSession } from "@/lib/mock/agent-sdk-output";
import { ContextLoader } from "@/lib/orchestration/context";
import { getSession } from "@/lib/supabase/queries/sessions";
import { sbAdmin } from "@/lib/supabase/server";
import { STATUS_TO_TOKEN } from "@/lib/types/ui";

const TERMINAL_STATUSES = new Set(["done", "killed"]);

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

  const mock = getMockedOutputForSession(session);
  const statusVar = `var(${STATUS_TO_TOKEN[session.status]})`;
  const statusLabel = session.status.replace(/_/g, " ");

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
          <DiffPreview diff={mock.diff} />

          {session.status === "awaiting_review" ? (
            <ActionBar sessionId={session.id} skills={ctx.skills} />
          ) : (
            <TerminalBanner session={session} />
          )}
        </>
      ) : (
        <NotReadyPlaceholder statusLabel={statusLabel} />
      )}
    </main>
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
