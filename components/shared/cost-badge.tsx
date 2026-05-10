"use client";

// Step 5 placeholder. Step 14 replaces the body with the real realtime
// subscription on `llm_calls`; the import path and prop shape stay constant.
export function CostBadge({ initialUsd }: { initialUsd: number }) {
  return (
    <span className="font-mono text-sm">${initialUsd.toFixed(2)} today</span>
  );
}
