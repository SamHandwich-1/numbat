// Browser-safe anon-key client. USE ONLY for realtime subscriptions
// (session-list.tsx, cost-badge.tsx) — narrow carve-out from CLAUDE.md's
// "DB access: only from server" rule. New queries: lib/supabase/queries/
// via sbAdmin, passed as props. Never inline from(...) here.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/db";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in environment. " +
      "Copy .env.local.example to .env.local and fill in values from the Supabase dashboard.",
  );
}

export const sb: SupabaseClient<Database> = createClient<Database>(url, anonKey);
