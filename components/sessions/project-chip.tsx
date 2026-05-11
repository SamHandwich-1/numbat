// Renders a project's chip — short_code on a colour pair stored per
// project row. Consumed by SessionCard (step 10), the focus banner
// (step 11), and the project filter dropdown (step 11).

import { cn } from "@/lib/utils";
import type { Project } from "@/lib/types/db";

export function ProjectChip({
  project,
  className,
}: {
  project: Project;
  className?: string;
}) {
  return (
    <span
      // chip_bg / chip_fg are dynamic per-project values from the DB,
      // so they can't be Tailwind utilities — passed via style prop directly.
      style={{ backgroundColor: project.chip_bg, color: project.chip_fg }}
      className={cn(
        "rounded-md px-1.5 py-0.5 text-xs font-mono uppercase tracking-wider",
        className,
      )}
    >
      {project.short_code}
    </span>
  );
}
