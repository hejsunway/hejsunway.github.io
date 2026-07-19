// filepath: lib/supabase/client.ts
// Browser-side Supabase client. Re-created on every call so it always
// reflects the current cookie/tab context. NEVER cache this in module
// scope — server components, route handlers, and server actions must use
// lib/supabase/server.ts instead.
import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/supabase/types";

export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

  if (!url || !anonKey) {
    throw new Error(
      "Missing Supabase env vars. Set NEXT_PUBLIC_SUPABASE_URL and one of " +
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY " +
        "in .env.local before calling the browser client.",
    );
  }

  return createBrowserClient<Database>(url, anonKey);
}
