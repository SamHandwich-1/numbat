"use client";

// Today's spend badge. Server-rendered seed via initialUsd (set in
// app/layout.tsx from getTodayCostUsd); the client subscribes to
// llm_calls INSERTs and adds each new row's cost_usd to the total.
//
// Filter choice — client-side (in-handler), not the Postgres-filter
// option on the realtime channel. Reasons:
//   1. Realtime filters are set at subscribe-time. The "today" boundary
//      computed at mount goes stale once Melbourne ticks past midnight;
//      yesterday's filter would keep accepting tomorrow's events. The
//      client-side check re-evaluates the boundary per event and drops
//      stale rows naturally.
//   2. V1 LLM call volume is low (single operator) — the savings of a
//      server-side filter don't justify the rollover risk.
//
// What this badge does NOT do: reset the displayed total at midnight.
// Slice 2a is additive-only; the operator's morning page reload re-seeds
// from the server. A future slice can add a midnight refresh if needed.

import { useEffect, useState } from "react";

import { sb } from "@/lib/supabase/client";
import { isMelbourneToday } from "@/lib/time/melbourne";
import type { LlmCall } from "@/lib/types/db";

export function CostBadge({ initialUsd }: { initialUsd: number }) {
  const [usd, setUsd] = useState<number>(initialUsd);

  useEffect(() => {
    const channel = sb
      .channel("llm_calls:today")
      .on<LlmCall>(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "llm_calls" },
        (payload) => {
          if (!isMelbourneToday(payload.new.created_at)) return;
          // cost_usd is numeric(10,6); postgrest delivers it as string.
          // Convert at the boundary, mirroring getTodayCostUsd's pattern.
          setUsd((prev) => prev + Number(payload.new.cost_usd));
        },
      )
      .subscribe();
    // Same HMR-leak concern as session-list — without removeChannel,
    // every dev-server save accumulates a stale channel + listener.
    return () => {
      sb.removeChannel(channel);
    };
  }, []);

  return <span className="font-mono text-sm">${usd.toFixed(2)} today</span>;
}
