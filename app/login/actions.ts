"use server";

// Server Action invoked by app/login/login-attempt.tsx (client). The
// cookie write must live here (or in a Route Handler / Middleware) —
// Next 15 restricts cookie mutations to those three contexts. Server
// Components cannot call cookies().set(...).
//
// The action takes the token from the client (which read it from
// the URL searchParams). The token traverses: URL → page server
// component → client prop → action argument. Server-side validation
// happens here against env.NUMBAT_AUTH_TOKEN.

import { cookies } from "next/headers";

import { env } from "@/lib/env";

export type LoginResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "mismatch" };

export async function attemptLogin(token: string): Promise<LoginResult> {
  if (!token) return { ok: false, reason: "missing" };
  // Plain === per plan §3 threat model. Same call as middleware.
  if (token !== env.NUMBAT_AUTH_TOKEN) {
    return { ok: false, reason: "mismatch" };
  }

  const cookieStore = await cookies();
  cookieStore.set("numbat_auth", token, {
    httpOnly: true,
    sameSite: "lax",
    // Dev runs on http://localhost; secure-only would block the
    // cookie. Production https deployments flip this on.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // 1 year. Plan §3 says "no expiry — single operator"; the
    // intent is "operator sets the cookie once via the bookmark
    // and stays signed in across browser restarts", which means
    // a long maxAge rather than a session cookie (which clears
    // on browser close).
    maxAge: 60 * 60 * 24 * 365,
  });
  return { ok: true };
}
