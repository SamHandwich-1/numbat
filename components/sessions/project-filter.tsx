"use client";

// Project filter dropdown. URL search params (?project=<short_code>) are
// the single source of truth — no local React state for the value, so a
// page reload or a shared link round-trips identically. The full project
// list is passed in by the parent RSC (listProjects()), independent of
// listSessions's filtered embed, so NB stays selectable even when the
// current filter happens to return no NB sessions.

import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Project } from "@/lib/types/db";

// Radix Select rejects "" as a SelectItem value, so the "no filter" option
// gets a sentinel that lives only in component state — never written to the
// URL. URL absence is canonical.
const ALL = "__all__";

export function ProjectFilter({ projects }: { projects: Project[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get("project") ?? ALL;

  const onChange = (next: string) => {
    const np = new URLSearchParams(params.toString());
    if (next === ALL) np.delete("project");
    else np.set("project", next);
    const qs = np.toString();
    router.replace((qs ? `${pathname}?${qs}` : pathname) as Route, {
      scroll: false,
    });
  };

  return (
    <Select value={current} onValueChange={onChange}>
      <SelectTrigger className="w-[200px]" aria-label="Filter by project">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All projects</SelectItem>
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.short_code}>
            {p.short_code} · {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
