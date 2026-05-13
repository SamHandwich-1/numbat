"use client";

// Mounts on /login. Calls the Server Action with the URL's token;
// on success, clears localStorage and replaces history with `next`;
// on miss/mismatch, renders the inline error message.
//
// Initial server-rendered state is "Signing in…" — matches the
// client's first render so no hydration mismatch. The error state
// is reached only after the action resolves on the client.

import { useEffect, useState } from "react";

import { attemptLogin } from "./actions";

type Status = "pending" | "error";

export function LoginAttempt({
  token,
  next,
}: {
  token: string;
  next: string;
}) {
  const [status, setStatus] = useState<Status>("pending");

  useEffect(() => {
    if (!token) {
      setStatus("error");
      return;
    }
    let cancelled = false;
    void (async () => {
      const result = await attemptLogin(token);
      if (cancelled) return;
      if (result.ok) {
        try {
          localStorage.removeItem("numbat:last_project_id");
        } catch {
          // localStorage may throw in private mode or under strict
          // browser settings. Fail silent — the redirect still
          // matters.
        }
        // replace, not assign — so /login doesn't end up in browser
        // history. No back-button bounce to a dead login page once
        // the cookie is set.
        window.location.replace(next);
      } else {
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, next]);

  if (status === "error") {
    return (
      <main className="mx-auto flex max-w-md flex-col gap-3 px-4 py-12">
        <h1 className="text-xl">Invalid token.</h1>
        <p className="text-sm text-muted-foreground">
          Sign in via your bookmarked URL:{" "}
          <code className="font-mono">
            /login?token=&lt;NUMBAT_AUTH_TOKEN&gt;
          </code>
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-md items-center justify-center px-4 py-12">
      <p className="font-mono text-sm text-muted-foreground">Signing in…</p>
    </main>
  );
}
