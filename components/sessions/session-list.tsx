"use client";

// Realtime owner for the sessions surface. Server-fetched initialSessions
// seed the client snapshot; postgres_changes events on `sessions` keep it
// live. Filters (?project, ?status) and focus (?focus) are read fresh from
// useSearchParams() on every render — the URL is the source of truth, the
// snapshot is a derived local cache. A new realtime row that doesn't match
// the active filter still flows in; the filter pass hides it. That keeps
// the snapshot in sync with the database regardless of which subset is
// currently shown.
//
// projects is the FULL project list from listProjects(), not the embedded
// subset returned by listSessions(). The full list is needed both to
// resolve any session that arrives via realtime (its project may not be
// in the filtered embed) and to compare against ?focus= for dimming.

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { SessionCard } from "@/components/sessions/session-card";
import { sb } from "@/lib/supabase/client";
import type { Project, Session, SessionStatus } from "@/lib/types/db";

export function SessionList({
  initialSessions,
  projects,
}: {
  initialSessions: Session[];
  projects: Project[];
}) {
  const [sessions, setSessions] = useState<Session[]>(initialSessions);
  const params = useSearchParams();

  // Re-seed when the RSC sends a new prop. useState ignores prop
  // changes after mount, so without this the snapshot stays frozen at
  // whatever the first server fetch returned — clicking back to "All
  // projects" from a filtered view would render the old filtered set.
  // Pending realtime updates between fetch and re-seed get re-delivered
  // on the next page load; acceptable for read-only 2a.
  useEffect(() => {
    setSessions(initialSessions);
  }, [initialSessions]);

  useEffect(() => {
    const channel = sb
      .channel("sessions:all")
      .on<Session>(
        "postgres_changes",
        { event: "*", schema: "public", table: "sessions" },
        (payload) => {
          setSessions((prev) => {
            switch (payload.eventType) {
              case "INSERT":
                return [
                  payload.new,
                  ...prev.filter((s) => s.id !== payload.new.id),
                ];
              case "UPDATE":
                return prev.map((s) =>
                  s.id === payload.new.id ? payload.new : s,
                );
              case "DELETE": {
                // DELETE payloads only carry the primary key in `old`.
                const id = (payload.old as { id?: string }).id;
                return id ? prev.filter((s) => s.id !== id) : prev;
              }
              default:
                return prev;
            }
          });
        },
      )
      .subscribe();
    // Critical cleanup: HMR re-runs this effect on every save, and
    // without removeChannel the previous channel keeps its websocket
    // open and its listener attached. After a few saves the dev server
    // is fanning the same event into a dozen stale callbacks, each
    // pushing into a stale setState.
    return () => {
      sb.removeChannel(channel);
    };
  }, []);

  const projectsById = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  const projectFilter = params.get("project");
  const statusFilter = params.get("status") as SessionStatus | null;
  const focus = params.get("focus");

  // Re-sort on every render — realtime INSERTs land at the head but
  // UPDATEs that bump updated_at need to re-flow into position. Cheap
  // for V1 (single operator, expected <100 cards).
  const ordered = [...sessions].sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at),
  );

  const filtered = ordered.filter((s) => {
    const project = projectsById.get(s.project_id);
    if (!project) return false;
    if (projectFilter && project.short_code !== projectFilter) return false;
    if (statusFilter && s.status !== statusFilter) return false;
    return true;
  });

  if (filtered.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No sessions match the current filters.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {filtered.map((s) => {
        const project = projectsById.get(s.project_id);
        // Guarded above — projectsById.get(s.project_id) returned a
        // value or the row was filtered out. Non-null assertion avoids
        // a redundant runtime check.
        if (!project) return null;
        const dimmed = !!focus && project.short_code !== focus;
        return (
          <li key={s.id}>
            <SessionCard session={s} project={project} dimmed={dimmed} />
          </li>
        );
      })}
    </ul>
  );
}
