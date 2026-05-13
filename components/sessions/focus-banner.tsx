"use client";

// Focus banner. Renders only when ?focus=<short_code> is present and is
// purely a render hint — off-project sessions are dimmed by SessionList,
// not removed (brief §11). The banner shows the focused project and a
// "Clear focus" link that removes only the focus param while preserving
// any active project/status filters.

import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { ProjectChip } from "@/components/sessions/project-chip";
import type { Project } from "@/lib/types/db";

export function FocusBanner({ projects }: { projects: Project[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const focus = params.get("focus");
  if (!focus) return null;

  const project = projects.find((p) => p.short_code === focus);

  const clear = () => {
    const np = new URLSearchParams(params.toString());
    np.delete("focus");
    const qs = np.toString();
    router.replace((qs ? `${pathname}?${qs}` : pathname) as Route, {
      scroll: false,
    });
  };

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-secondary px-3 py-2 text-sm">
      <span className="text-muted-foreground">Focused on</span>
      {project ? (
        <>
          <ProjectChip project={project} />
          <span>{project.name}</span>
        </>
      ) : (
        // Unknown short_code — render the raw value so the operator can
        // see what's wrong rather than silently hiding the banner.
        <span className="font-mono">{focus}</span>
      )}
      <button
        type="button"
        onClick={clear}
        className="ml-auto text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        Clear focus
      </button>
    </div>
  );
}
