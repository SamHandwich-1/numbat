// RECOVERY: if locked out of the app, two options:
//   1. DevTools → Application → Cookies → delete numbat_auth, then refresh.
//   2. Rotate NUMBAT_AUTH_TOKEN in .env.local and restart pnpm dev.
// Either restores access. This comment is non-negotiable; it's the
// operator's only safety net if this file ships with a bug.

// EDGE RUNTIME EXCEPTION: this file does NOT `import { env }` from
// @/lib/env. Middleware runs on Edge by default, which doesn't support
// fs/node:path/node:url — lib/env.ts's dotenv loader would crash at
// module load, and module-load errors cannot be caught by try/catch,
// making the entire app brick. Reading process.env directly here is
// safe because Next.js populates server env vars into process.env
// before middleware runs, independent of dotenv. The zod validation
// happens at /login (step 11c) instead — first redirect surfaces any
// malformed env to the operator.

import { NextResponse, type NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  // Fail-open on any runtime throw: redirect to /login. Worst case
  // the operator sees an unexpected login page; far better than
  // every request 500ing. Module-load errors can't reach this catch
  // (they'd prevent middleware from mounting entirely) — plan B's
  // process.env-not-lib/env approach sidesteps that risk.
  try {
    const expected = process.env.NUMBAT_AUTH_TOKEN;

    // Null/length check guards the silently-open-gate footgun: if
    // NUMBAT_AUTH_TOKEN is missing or malformed, both `expected`
    // and the cookie value are likely undefined, and a naive
    // `cookie === expected` would return true. The 16-char minimum
    // mirrors the zod schema in lib/env.ts (z.string().min(16)) —
    // physically separate but referencing the same operational
    // requirement. /login (step 11c) imports lib/env and surfaces
    // the zod parse error to the operator.
    if (!expected || expected.length < 16) {
      return redirectToLogin(req);
    }

    const token = req.cookies.get("numbat_auth")?.value;
    // Plain === per plan §3 threat model: the gate is "keep
    // accidental visitors out" of a single-operator dev machine,
    // not defend against timing attacks. Constant-time compare
    // would need crypto.timingSafeEqual with equal-length buffers;
    // not load-bearing for V1.
    if (token !== expected) {
      return redirectToLogin(req);
    }

    return NextResponse.next();
  } catch {
    // Residual runtime errors only — cookie parsing edge cases,
    // unexpected NextRequest shape, etc. Fail open.
    return redirectToLogin(req);
  }
}

function redirectToLogin(req: NextRequest): NextResponse {
  const url = new URL("/login", req.url);
  // Preserve original path + query in ?next= so /login can redirect
  // back after the cookie is set (step 11c). URLSearchParams.set
  // handles encoding.
  const next = req.nextUrl.pathname + req.nextUrl.search;
  url.searchParams.set("next", next);
  return NextResponse.redirect(url);
}

// Matcher per plan §3 (refined). Excludes /login (the gate itself),
// Next's internal asset paths, the favicon, and the entire /api/*
// tree. The /api/* exclusion is deliberate: route handlers do their
// own cookie check (plan §4 defence-in-depth) and return 401 — the
// machine-readable response shape API consumers need. Without the
// exclusion, middleware would 302 API requests to /login before
// the handlers could respond, which is hostile to fetch() callers.
// Page routes (everything else under /) still get gated here.
export const config = {
  matcher: [
    "/((?!login|_next/static|_next/image|favicon.ico|api).*)",
  ],
};
