"use client";

// Single-row realtime subscription on `sessions` filtered by the
// current id. Renders nothing — its only job is to call
// router.refresh() whenever this session's row changes, so the
// server-rendered detail page picks up the new status without a
// manual reload.
//
// Cleanup is non-negotiable: HMR re-runs this effect on every save
// and without removeChannel the previous channel keeps its websocket
// open and its callback attached. Matches the SessionList pattern.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { sb } from "@/lib/supabase/client";

export function SessionStatusSubscriber({ sessionId }: { sessionId: string }) {
  const router = useRouter();

  useEffect(() => {
    const channel = sb
      .channel(`sessions:${sessionId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "sessions",
          filter: `id=eq.${sessionId}`,
        },
        () => {
          // UPDATE is the expected event. The RSC re-runs and re-fetches
          // the session row; the new status drives which branch renders.
          router.refresh();
        },
      )
      .subscribe();
    return () => {
      sb.removeChannel(channel);
    };
  }, [sessionId, router]);

  return null;
}
