"use client";

import { useEffect, useState } from "react";

// Client island for the bucketed timestamp. SessionCard is a Server
// Component, so an inline relativeTime() call evaluating Date.now() at
// render time made SSR and the first client render disagree whenever
// the bucket boundary flipped between the two passes. Rendering the
// timestamp from a "use client" island with a "…" placeholder during
// SSR and the first client render fixes that — the SSR markup is
// deterministic and the real value snaps in after mount.
//
// Bonus: a 30s setInterval lets the displayed bucket tick forward
// without waiting for a parent re-render. Slice 3's session detail
// page wants the same behaviour for "started X ago", so the shape
// lands here once.
export function RelativeTime({ iso }: { iso: string }) {
  const [text, setText] = useState<string>("…");

  useEffect(() => {
    const tick = () => setText(formatRelative(iso, Date.now()));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [iso]);

  return <span>{text}</span>;
}

// Bucketed relative timestamp. Four buckets don't justify pulling
// Intl.RelativeTimeFormat; pure function takes `now` so a future test
// can pin the clock without mocking globals.
function formatRelative(iso: string, now: number): string {
  const diffSec = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
}
