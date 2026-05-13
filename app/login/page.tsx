// /login — single-operator auth gate. Operator's "session" is the
// bookmark `http://localhost:3000/login?token=<NUMBAT_AUTH_TOKEN>`.
// Hitting it sets a long-lived httpOnly cookie and bounces back to
// ?next= (default /sessions). No password form — the URL is the
// credential (plan §3 threat model: keep accidental visitors out
// of a single-operator dev machine, not defend against attackers).
//
// Three-file split is forced by Next 15's restriction that cookies
// can only be written from Server Actions, Route Handlers, or
// Middleware — not Server Components. So:
//   - page.tsx (this file, server) extracts searchParams
//   - login-attempt.tsx (client) calls the action and renders
//     pending / success / error states
//   - actions.ts (Server Action) validates the token and writes
//     the cookie
//
// /login is excluded from the middleware matcher (middleware.ts),
// so this page is reachable without a cookie. That's intentional —
// it's the only door in.

import { LoginAttempt } from "./login-attempt";

// Reject open-redirect targets. `next` should be a same-origin
// path. V1 doesn't have an attacker model that cares about this,
// but the cost is one helper.
function safeNext(raw: string | string[] | undefined): string {
  if (typeof raw !== "string") return "/sessions";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/sessions";
  return raw;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    token?: string | string[];
    next?: string | string[];
  }>;
}) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";
  const next = safeNext(sp.next);
  return <LoginAttempt token={token} next={next} />;
}
