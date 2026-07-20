import { createClient } from "@/lib/supabase/server";

export async function getBillingOverview() {
  const supabase = await createClient();
  const [walletResult, lotsResult, ledgerResult, paymentResult, subscriptionResult] = await Promise.all([
    supabase.from("aido_credit_wallets").select("*").maybeSingle(),
    supabase.from("aido_credit_lots").select("*").order("created_at", { ascending: false }).limit(20),
    supabase.from("aido_credit_ledger").select("*").order("id", { ascending: false }).limit(50),
    supabase.from("aido_payment_events").select("*").order("received_at", { ascending: false }).limit(20),
    supabase.from("aido_subscriptions").select("*").order("last_synced_at", { ascending: false }).limit(10),
  ]);
  const error = walletResult.error ?? lotsResult.error ?? ledgerResult.error ?? paymentResult.error ?? subscriptionResult.error;
  if (error && ["42P01", "PGRST205"].includes(error.code)) {
    return { wallet: null, lots: [], ledger: [], payments: [], subscriptions: [], available: false };
  }
  if (error) throw error;
  return {
    wallet: walletResult.data,
    lots: lotsResult.data ?? [],
    ledger: ledgerResult.data ?? [],
    payments: paymentResult.data ?? [],
    subscriptions: subscriptionResult.data ?? [],
    available: true,
  };
}
