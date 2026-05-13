// POST /api/start-work — orchestration entry. The Start Work form
// (step 12 component) submits here. Flow:
//
//   auth → validate body → verify project → route(brief) → branch
//   into createSession (Direct) or createPlan (Bilby) → return
//   { pipeline, matched_rule, redirect_url }.
//
// Plan §4 destinations: `/sessions/<id>` (built in slice 3) and
// `/plans/<id>` (built in slice 5). Both 404 in 2b — the operator's
// mental model ("brief submitted → row exists → URL is correct")
// doesn't depend on the destination being styled. The Sessions list
// auto-updates via 2a realtime, so Direct-routed sessions also
// appear there within ~1s of submit.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { env } from "@/lib/env";
import { createPlan } from "@/lib/orchestration/create-plan";
import { createSession } from "@/lib/orchestration/create-session";
import { route } from "@/lib/orchestration/router";
import { sbAdmin } from "@/lib/supabase/server";

const StartWorkRequest = z.object({
  projectId: z.string().uuid(),
  brief: z.string().trim().min(1).max(5000),
});

export async function POST(req: Request) {
  // Auth — same defence-in-depth pattern as /api/sessions. 401 on
  // miss, not 302 — API responses are machine-readable.
  const cookieStore = await cookies();
  const token = cookieStore.get("numbat_auth")?.value;
  if (token !== env.NUMBAT_AUTH_TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const json: unknown = await req.json().catch(() => null);
  const parsed = StartWorkRequest.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.message },
      { status: 400 },
    );
  }
  const { projectId, brief } = parsed.data;

  // Verify project exists before routing. A bad projectId would
  // otherwise produce a confusing FK violation from the eventual
  // INSERT; catching it here gives a clear 400 with a useful message.
  // maybeSingle so a miss returns data=null without surfacing as an
  // error from PostgREST.
  const { data: project, error: projectError } = await sbAdmin
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .maybeSingle();
  if (projectError) {
    return NextResponse.json(
      { error: projectError.message },
      { status: 500 },
    );
  }
  if (!project) {
    return NextResponse.json(
      { error: `project ${projectId} not found` },
      { status: 400 },
    );
  }

  // Router is pure + sync. Defensive throw on empty/whitespace is
  // unreachable here (zod .trim().min(1) rejects upstream), but
  // route() keeps it as its own contract.
  const decision = route(brief);

  // Branch on the routed pipeline. Both paths create an artifact
  // and a triggering decisions row inside the helper; only the
  // redirect target differs.
  try {
    if (decision.pipeline === "direct") {
      const { id } = await createSession({ projectId, brief, decision });
      return NextResponse.json(
        {
          pipeline: decision.pipeline,
          matched_rule: decision.matched_rule,
          redirect_url: `/sessions/${id}`,
        },
        { status: 200 },
      );
    }
    const { id } = await createPlan({ projectId, brief, decision });
    return NextResponse.json(
      {
        pipeline: decision.pipeline,
        matched_rule: decision.matched_rule,
        redirect_url: `/plans/${id}`,
      },
      { status: 200 },
    );
  } catch (err) {
    // single-operator local-first concession; would be sanitized in
    // a multi-user product. Operator wants the actual constraint
    // violation or FK error during dev.
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
