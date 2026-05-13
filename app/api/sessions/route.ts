// POST /api/sessions — lower-level Direct-create endpoint. Bypasses
// the router entirely (synthetic decision with matched_rule='manual')
// and writes a session row + its bookkeeping decisions row via
// createSession.
//
// Reserved for callers outside the Start Work flow:
//   - Slice 3+ "retry session" affordance from a session detail page
//   - Future programmatic creates that don't need router classification
//
// /api/start-work (step 9) does NOT delegate here — it calls
// createSession directly with the real RouterDecision so the
// decisions row carries the actual matched_rule.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { env } from "@/lib/env";
import { createSession } from "@/lib/orchestration/create-session";
import type { RouterDecision } from "@/lib/orchestration/router";

const SessionsPostRequest = z.object({
  projectId: z.string().uuid(),
  brief: z.string().trim().min(1).max(5000),
});

export async function POST(req: Request) {
  // Auth check via cookie. Defence in depth on mutation endpoints
  // (plan §4) — middleware (step 11a) will gate this too, but route
  // handlers shouldn't assume earlier filters ran. 401 (not 302) so
  // API consumers get a machine-readable response.
  //
  // Plain `===` rather than constant-time compare; per plan §3
  // threat model the gate is "keep accidental visitors out" of a
  // single-operator dev machine, not defend against timing attacks.
  const cookieStore = await cookies();
  const token = cookieStore.get("numbat_auth")?.value;
  if (token !== env.NUMBAT_AUTH_TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const json: unknown = await req.json().catch(() => null);
  const parsed = SessionsPostRequest.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.message },
      { status: 400 },
    );
  }
  const { projectId, brief } = parsed.data;

  // Synthetic decision — /api/sessions has no router involvement.
  // matched_rule='manual' is the synthetic-only value reserved for
  // exactly this path (see lib/orchestration/router.ts).
  const syntheticDecision: RouterDecision = {
    pipeline: "direct",
    matched_rule: "manual",
    reason: "Created via /api/sessions, no router involvement",
  };

  try {
    const { id } = await createSession({
      projectId,
      brief,
      decision: syntheticDecision,
    });
    return NextResponse.json({ id }, { status: 200 });
  } catch (err) {
    // single-operator local-first concession; would be sanitized in
    // a multi-user product. The operator wants to see the actual
    // constraint violation or FK error during dev, not a generic
    // "something went wrong".
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
