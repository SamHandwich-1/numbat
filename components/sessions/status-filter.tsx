"use client";

// Status filter dropdown. Same URL-as-source-of-truth pattern as
// ProjectFilter. Options come from the SessionStatus enum directly so a
// new status added to lib/types/db.ts surfaces here automatically.

import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SessionStatus } from "@/lib/types/db";

const ALL = "__all__";

// Operational priority order: live/actionable first, terminal last. The DB
// enum order in lib/types/db.ts is alphabetical-ish; this is the order an
// operator scans first.
const STATUS_ORDER: SessionStatus[] = [
  "running",
  "awaiting_review",
  "blocked",
  "planning",
  "idle",
  "done",
  "killed",
];

export function StatusFilter() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get("status") ?? ALL;

  const onChange = (next: string) => {
    const np = new URLSearchParams(params.toString());
    if (next === ALL) np.delete("status");
    else np.set("status", next);
    const qs = np.toString();
    router.replace((qs ? `${pathname}?${qs}` : pathname) as Route, {
      scroll: false,
    });
  };

  return (
    <Select value={current} onValueChange={onChange}>
      <SelectTrigger className="w-[200px]" aria-label="Filter by status">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All statuses</SelectItem>
        {STATUS_ORDER.map((s) => (
          <SelectItem key={s} value={s}>
            {s.replace(/_/g, " ")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
