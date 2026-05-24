// POST /api/sessions/[sessionId]/decisions — review-flow decision
// endpoint. The ActionBar / ReplyComposer submit here for the three
// Slice 3 actions (approve / redirect / kill).
//
// Flow: auth → Zod parse → recordDecision → JSON response. The
// mutation helper handles the session-status change (Approve / Kill)
// internally; the route handler is a thin auth + parse layer.
//
// 401 (not 302) on auth miss because API responses are
// machine-readable. 500 (not 4xx) on guard violations is intentional
// — a Slice 3 client wouldn't submit against a non-awaiting_review
// session unless the operator opened a stale tab; surfacing the raw
// constraint message matches the create-session.ts dev concession.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { env } from "@/lib/env";
import { recordDecision } from "@/lib/supabase/mutations/decisions";
import { sbAdmin } from "@/lib/supabase/server";
import { DecisionPayload } from "@/lib/types/jsonb";

const DecisionRequest = z.object({
  type: z.enum(["approve", "redirect", "kill", "dismiss", "undismiss"]),
  payload: DecisionPayload,
  context: z.string().trim().min(1).max(5000).optional(),
});

export async function POST(
  req: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await context.params;

  const cookieStore = await cookies();
  const token = cookieStore.get("numbat_auth")?.value;
  if (token !== env.NUMBAT_AUTH_TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const json: unknown = await req.json().catch(() => null);
  const parsed = DecisionRequest.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.message },
      { status: 400 },
    );
  }
  const { type, payload, context: ctxNote } = parsed.data;

  // Discriminator alignment: the `type` field and `payload.type` must
  // agree. recordDecision repeats this check defensively, but
  // surfacing it as a 400 here gives the client a cleaner failure
  // signal than the mutation's generic "narrow failed" throw.
  if (payload.type !== type) {
    return NextResponse.json(
      { error: `type mismatch: type=${type}, payload.type=${payload.type}` },
      { status: 400 },
    );
  }

  try {
    const decision = await recordDecision(sbAdmin, {
      sessionId,
      type,
      payload,
      context: ctxNote ?? null,
    });
    return NextResponse.json(
      { decision_id: decision.id, session_id: sessionId },
      { status: 200 },
    );
  } catch (err) {
    // single-operator local-first concession; surface the actual
    // error during dev rather than masking it as "something went
    // wrong". The guard-failure ("session is done, not awaiting_review")
    // surfaces as a 500 — see header comment.
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
