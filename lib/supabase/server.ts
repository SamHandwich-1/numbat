import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/types/db";

if (typeof window !== "undefined") {
  throw new Error(
    "lib/supabase/server.ts must not be imported from client code. " +
      "Use lib/supabase/client.ts (anon key) for browser contexts.",
  );
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment. " +
      "Server-only code requires both. Check .env.local.",
  );
}

export const sbAdmin: SupabaseClient<Database> = createClient<Database>(
  url,
  serviceRoleKey,
  {
    auth: { persistSession: false, autoRefreshToken: false },
  },
);
