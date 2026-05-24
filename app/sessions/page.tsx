// Sessions surface RSC. Reads filter params from the URL, fans out the
// two server queries it consumes in parallel, and composes the Start
// Work input, the filter bar, the focus banner, and the realtime
// SessionList. Client components handle all interaction; this file
// does no `"use client"` work.

import { listProjects, listSessions } from "@/lib/supabase/queries/sessions";
import type { SessionFilters } from "@/lib/types/ui";
import type { SessionStatus } from "@/lib/types/db";
import { FocusBanner } from "@/components/sessions/focus-banner";
import { ProjectFilter } from "@/components/sessions/project-filter";
import { SessionList } from "@/components/sessions/session-list";
import { ShowDismissedToggle } from "@/components/sessions/show-dismissed-toggle";
import { StartWorkInput } from "@/components/sessions/start-work-input";
import { StatusFilter } from "@/components/sessions/status-filter";

// All eight SessionStatus values are accepted as URL filter values.
// `killing` is the Slice 4 transient state — it's not exposed as a
// user-pickable chip in StatusFilter (which uses STATUS_ORDER), but a
// URL like `?status=killing` is still valid and should resolve. Prior
// to Slice 5 this set silently rejected `killing`; the inclusion here
// is the fix.
const KNOWN_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "idle",
  "planning",
  "running",
  "awaiting_review",
  "blocked",
  "done",
  "killed",
  "killing",
]);

function isSessionStatus(s: string): s is SessionStatus {
  return KNOWN_STATUSES.has(s as SessionStatus);
}

export default async function SessionsPage({
  searchParams,
}: {
  // Next 15: searchParams is a Promise.
  searchParams: Promise<{
    project?: string;
    status?: string;
    focus?: string;
    dismissed?: string;
  }>;
}) {
  // Awaiting searchParams forces dynamic rendering, which lets
  // client-component useSearchParams() work without a Suspense boundary.
  const sp = await searchParams;

  // Reject unknown status values rather than passing them to the DB —
  // an unknown value would return zero rows silently. Project codes
  // pass through unchecked because the project set is dynamic data.
  const filters: SessionFilters = {};
  if (sp.project) filters.projectShortCode = sp.project;
  if (sp.status && isSessionStatus(sp.status)) filters.status = sp.status;
  // Slice 5: default Sessions list filters `dismissed_at IS NULL`;
  // `?dismissed=show` lifts the filter (per 0009 §D + Stage 3). Any
  // other value falls through to the default (filter on).
  if (sp.dismissed === "show") filters.includeDismissed = true;

  // Fan out the two queries the page actually consumes. listSessions
  // returns an embedded project subset; listProjects returns the
  // canonical full list (used by the filter dropdown, the focus banner,
  // and SessionList for project lookup on realtime-arrived sessions).
  // The cost number is fetched in app/layout.tsx — the layout owns it.
  const [{ sessions }, projects] = await Promise.all([
    listSessions(filters),
    listProjects(),
  ]);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
      {/* Start Work input — top chrome, visually divided from the list
          below by border-b + pb-4 per plan §2. */}
      <div className="border-b border-border pb-4">
        <StartWorkInput projects={projects} />
      </div>
      {/* Slice 5 polish: filter row sticks below the app header so it stays
          reachable while scrolling the list. `top-9` (36px) matches the
          app header's rendered height (sticky top-0 z-40 in app/layout.tsx
          — py-2 + small-text content ≈ 36px). `z-10` sits in the app's
          stacking order: below the header (z-40) and shadcn popovers
          (z-50), above page content. `bg-background` is opaque so the
          scrolling list doesn't bleed through. */}
      <div className="sticky top-9 z-10 flex flex-wrap gap-2 bg-background sm:flex-nowrap">
        <ProjectFilter projects={projects} />
        <StatusFilter />
        <ShowDismissedToggle />
      </div>
      <FocusBanner projects={projects} />
      <SessionList initialSessions={sessions} projects={projects} />
    </main>
  );
}
