"use client";

// "Show dismissed" toggle for the Sessions list. URL-as-source-of-truth
// pattern matching ProjectFilter / StatusFilter — flips the
// `?dismissed=show` query param on/off; the server-side list page reads
// the param and lifts the default `dismissed_at IS NULL` filter
// accordingly (lib/supabase/queries/sessions.ts).

import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";

export function ShowDismissedToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const showing = params.get("dismissed") === "show";

  const onClick = () => {
    const np = new URLSearchParams(params.toString());
    if (showing) np.delete("dismissed");
    else np.set("dismissed", "show");
    const qs = np.toString();
    router.replace((qs ? `${pathname}?${qs}` : pathname) as Route, {
      scroll: false,
    });
  };

  return (
    <Button
      type="button"
      variant={showing ? "secondary" : "ghost"}
      size="sm"
      onClick={onClick}
      aria-pressed={showing}
      className="w-full sm:w-auto"
    >
      {showing ? "Hide dismissed" : "Show dismissed"}
    </Button>
  );
}
