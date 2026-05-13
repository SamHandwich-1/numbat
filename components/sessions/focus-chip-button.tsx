"use client";

// Click-to-focus chip wrapper. Renders the project chip as a button
// that toggles ?focus=<short_code> in the URL — same URL-as-source-of-
// truth pattern as the other filter components. Clicking a chip while
// it's already the focused project clears focus (toggle).
//
// FocusBanner keeps using the bare ProjectChip — its chip is a status
// indicator next to the dedicated "Clear focus" link, not an action.

import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { ProjectChip } from "@/components/sessions/project-chip";
import type { Project } from "@/lib/types/db";

export function FocusChipButton({ project }: { project: Project }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const focused = params.get("focus") === project.short_code;

  const onClick = () => {
    const np = new URLSearchParams(params.toString());
    if (focused) np.delete("focus");
    else np.set("focus", project.short_code);
    const qs = np.toString();
    router.replace((qs ? `${pathname}?${qs}` : pathname) as Route, {
      scroll: false,
    });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={focused}
      title={focused ? "Clear focus" : `Focus on ${project.name}`}
      className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring hover:opacity-80"
    >
      <ProjectChip project={project} />
    </button>
  );
}
