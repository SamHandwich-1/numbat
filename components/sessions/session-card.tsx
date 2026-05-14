// Session card — list-row rendering of a single Session row plus its
// joined Project. Server-renderable, presentational, non-interactive in
// slice 2a. Single-session route lands in slice 3.

import { cn } from "@/lib/utils";
import { STATUS_TO_TOKEN } from "@/lib/types/ui";
import type { Project, Session } from "@/lib/types/db";
import { Card } from "@/components/ui/card";
import { FocusChipButton } from "@/components/sessions/focus-chip-button";
import { RelativeTime } from "@/components/sessions/relative-time";

export function SessionCard({
  session,
  project,
  dimmed = false,
}: {
  session: Session;
  project: Project;
  dimmed?: boolean;
}) {
  const glyph =
    session.status === "done" ? "✓" : session.status === "killed" ? "×" : null;
  const statusVar = `var(${STATUS_TO_TOKEN[session.status]})`;
  const statusLabel = session.status.replace(/_/g, " ");

  return (
    <Card
      // Stock shadcn Card has no hover affordance, so no override classes
      // are needed in slice 2a. If the primitive gains hover styles in a
      // future slice (clickable cards in slice 3+, plan cards in slice 5+),
      // this site will need to opt out explicitly.
      className={cn(
        "flex flex-col gap-1 p-3 text-sm cursor-default",
        dimmed && "opacity-50",
      )}
      // React omits the attribute when undefined; passing false would
      // emit aria-disabled="false" which is semantic noise.
      aria-disabled={dimmed || undefined}
    >
      <div className="flex items-center gap-2">
        <FocusChipButton project={project} />
        {glyph ? (
          <span
            className="text-xs leading-none"
            style={{ color: statusVar }}
            aria-hidden="true"
          >
            {glyph}
          </span>
        ) : (
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              session.status === "running" && "status-dot--pulse",
            )}
            style={{ backgroundColor: statusVar }}
            aria-hidden="true"
          />
        )}
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {statusLabel} · <RelativeTime iso={session.updated_at} />
        </span>
      </div>

      <p className="font-mono text-xs text-muted-foreground">{session.slice_name}</p>

      <p>{session.task}</p>

      {session.status === "blocked" && session.last_error && (
        <p className="truncate text-muted-foreground">
          <span
            className="mr-2 font-mono text-xs uppercase tracking-wider"
            style={{ color: "var(--color-coral)" }}
          >
            blocked
          </span>
          {session.last_error.message}
        </p>
      )}
    </Card>
  );
}
