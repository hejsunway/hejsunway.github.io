# Phase 2 Progress Audit

> Date: 2026-07-20
> Scope: prepaid credits, Stripe payments, provider gateway, and loss controls
> Release status: schema and privilege mechanisms verified on isolated staging; paid external flows remain disabled

## Completed locally

- Versioned billing configuration, provider prices, feature rate cards, approved provider routes, credit products, and operational kill switches.
- Non-negative wallets, expiring credit lots, append-only ledger, reservations, allocations, provider authorizations, usage events, verified payment events, refunds, chargebacks, and unrecovered-credit freezes.
- Service-only atomic grant, reserve, authorize, usage-record, settle, release, expiry, refund, chargeback, and reconciliation functions. Browser roles have read-own RLS only and cannot execute financial mutations.
- Exactly-once validation rejects reuse of a job, usage, provider, settlement, release, or Stripe event key when any material facts change.
- Global, feature, provider, and model daily budgets and concurrent-call controls. Missing controls, rates, routes, wallets, or secrets fail closed.
- Server-only integer quote calculation with a configured FX buffer and provider-cost margin floor.
- One server-only gateway with fixed-endpoint adapters for OpenAI Responses, DeepSeek Chat Completions, and MiniMax Chat Completions. The immutable reservation selects the provider/model; feature and browser code cannot override it.
- A one-way provider-dispatch claim prevents a crashed retry from issuing the same paid request twice. Expired dispatched calls without usage become durable critical reconciliation issues.
- Ambiguous dispatched calls remain reconciliation issues even after student credits are released, so a late provider invoice cannot silently erase the exposure.
- Hard token/tool/search/page/cost ceilings, timeout, actual usage capture, output validation, settlement, and release-on-known-failure. Network or protocol ambiguity remains fail-closed for reconciliation instead of risking a duplicate provider charge.
- Strict real-configuration command (`pnpm billing:config /path/config.json`) with no defaults or bundled product data. It validates exact fields, provider routes, control coverage, credit funding, and conservative minimum-charge margin; `--apply` calls one idempotent, transactional service-only database import.
- Configuration preflight and apply are bound to the approved project ref for each environment. A staging-labelled import fails before network access if its Supabase URL points at the shared production project or any other project.
- Stripe Checkout for effective one-time top-up and subscription products, raw-body webhook signature verification, settled net-amount retrieval, one-time purchase and paid-invoice credit grants, refund reversal, and dispute reversal.
- Webhook processing verifies the event's `livemode` against the configured Stripe secret-key mode, preventing test/live environment crossover.
- Server-written subscription projection for all Stripe lifecycle states, an append-only verified-event journal, stale-event protection, failed-payment state, duplicate-subscription guard, and a customer portal action bound to a reviewed portal configuration.
- Real `/app/billing` wallet, lot, ledger, payment, and subscription status. Environments without the Phase 2 schema show an honest unavailable state and no simulated balance.
- Daily, secret-protected reconciliation runner with durable run/issue records. It compares wallet/ledger/reservation/payment effects, recent Stripe objects, subscription projections, and immutable provider-invoice imports without moving credits.
- Separate daily, secret-protected financial maintenance expires overdue reservations before overdue credit lots. It processes bounded batches, isolates row failures, and leaves overdue state visible to reconciliation until successfully resolved.
- Real provider-invoice import command (`pnpm billing:import-provider-invoice`) hashes the supplied invoice record and accepts no built-in sample or fallback data.

## Requirement-by-requirement state

| Phase 2 plan requirement | Current evidence | State |
|---|---|---|
| Versioned provider prices and feature rate cards | Core migration plus server-side integer quote calculation | Complete locally |
| Lots, wallet, append-only ledger, reservations, usage, payments, refunds, reversals | Core and atomic migrations; pgTAP invariants | Complete locally |
| Atomic reserve, settle, release, expire, refund, chargeback | Service-only functions plus concurrency test | Complete locally |
| Verified, idempotent Stripe grants | Raw-signature route and atomic event functions | Code complete; external Stripe test-mode evidence missing |
| Real balance, history, subscription, and top-up interfaces | Real wallet/history, Checkout, lifecycle projection, and configured portal action | Code complete; external Stripe test-mode evidence missing |
| Plan/user/concurrency/provider controls and kill switches | Rate cards, system controls, provider budget authorization | Complete locally |
| Server-only gateway with hard ceilings | OpenAI, DeepSeek, and MiniMax adapters; database authorization plus single-dispatch claim | Complete locally; external call evidence missing |
| Provider-reported usage and actual-cost capture | Token/cache/tool/search/latency/request/cost fields, settlement, and provider-invoice comparison | Code complete; first real provider export/invoice evidence missing |
| Approved lower-cost routing | Versioned approved route table and fail-closed lookup | Mechanism complete; no reviewed effective configuration |
| Automated financial and provider-invoice reconciliation | Durable daily runner, Stripe comparison, immutable hashed invoice import, and internal mismatch functions | Complete locally and schema-verified on staging; requires first real invoice and Stripe test run |

## Verification evidence

```text
supabase db reset --local --no-seed        pass
supabase db lint --local --level warning   no schema errors
supabase test db --local                   197/197 pass
pnpm test:phase2                           concurrent duplicate/overspend pass
pnpm test:billing-config                   environment/project boundary pass
pnpm test:providers                        OpenAI/DeepSeek/MiniMax contracts pass
supabase db advisors --local --fail-on warn no issues
pnpm check:no-demo                         pass
pnpm lint                                  pass
pnpm typecheck                             pass
pnpm build                                 pass
```

The concurrency test makes two simultaneous identical reservations and proves one reservation/ledger effect. It then makes two distinct simultaneous 80-credit reservations against a 100-credit wallet and proves exactly one succeeds. The test is localhost-only, requires `AIDO_ALLOW_LOCAL_DB_RESET=1`, and resets the isolated database afterward so no fixture data remains.

## Not complete / not authorized for release

- The isolated `AidoForMe Staging` Supabase project (`vokjkogzvtohdinhxhkk`, Singapore, $0/month) contains all Phase 1 and Phase 2 migrations through `aido_phase_two_scheduled_expiry` (nine Phase 2 migrations). All eight grouped schema/RLS/grant/index checks pass. Security and performance advisors report no warning/error findings; remaining informational notices are expected for deny-by-default service tables and unused indexes in an empty database.
- Stripe is now authenticated to the isolated `AidoForMe` sandbox account
  `acct_1Tv6yz1tdTVob40G`. The approved RM20/2,000-credit top-up and
  RM29/2,900-credit monthly prices are verified with `livemode: false`, and the
  expiry descriptions/metadata record 180 days and 35 days respectively. The
  cancellation-only portal configuration `bpc_1Tv93i1tdTVob40Gc9FMuhaa` is
  active with payment-method updates and invoice history enabled, cancellation
  at period end, and plan/quantity changes disabled. See
  [`phase-two-stripe-staging-evidence.md`](./phase-two-stripe-staging-evidence.md).
  No webhook endpoint or payment/refund/dispute lifecycle evidence exists yet.
- No provider API key was used and no chargeable provider call was made.
- Subscription lifecycle and reconciliation code are complete locally, but test-mode Checkout, webhook delivery, portal cancellation, retry/dunning, refund, and dispute evidence is still required.
- The Vercel daily schedule runs only for production deployments. A staging Vercel project must therefore use its own production deployment and set `CRON_SECRET`; preview deployments do not execute the schedule.
- Provider invoice reconciliation has a real import path but cannot be proven until a real provider export/invoice is supplied. Network failures with no provider-reported usage rely on this comparison to discover a late provider charge.
- Product prices, credit grants, provider rates, approved models, privacy approvals, limits, and kill switches have no seed data. Staging was rechecked after migration and still has zero configuration imports, configs, prices, rates, routes, products, controls, wallets, provider authorizations, and usage events. A reviewed real configuration file is required before any paid feature can run.
- Secret-safe local inspection on 2026-07-20 found `.env.local` still targets the shared production Supabase URL and does not define the Phase 2 service-role, Stripe, cron, target, or provider variables. It must not be used for staging evidence; configure a separate staging environment without committing or printing secret values.
- No Phase 2 migration has been applied to the linked shared production database. Production promotion still requires explicit approval after the external staging gate.
- No student-facing AI feature invokes the gateway yet. Phase 3’s real requirement-analysis slice is the first intended low-risk feature.

## Release decision

Keep Phase 2 disabled in production. Sandbox connection, real Aido
products/prices, and the cancellation-only portal configuration are complete.
The remaining Phase 2 exit gate is external and configuration-specific:
configure a staging deployment, webhook, and server secrets; complete the
provider quality gate and reviewed billing configuration; perform the first
real provider response and invoice/export comparison; and pass the full
Checkout/subscription/refund/dispute/cron evidence set. Then review the
additive production migration set separately.
