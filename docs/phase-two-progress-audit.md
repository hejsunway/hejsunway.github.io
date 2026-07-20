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
- Secret-safe deployed-cron verifier proves unauthenticated denial, invokes each staging production route exactly once, and verifies the persisted reconciliation run without printing credentials or retrying ambiguous mutations.

## Requirement-by-requirement state

| Phase 2 plan requirement | Current evidence | State |
|---|---|---|
| Versioned provider prices and feature rate cards | Core migration plus server-side integer quote calculation | Complete locally |
| Lots, wallet, append-only ledger, reservations, usage, payments, refunds, reversals | Core and atomic migrations; pgTAP invariants | Complete locally |
| Atomic reserve, settle, release, expire, refund, chargeback | Service-only functions plus concurrency test | Complete locally |
| Verified, idempotent Stripe grants | Raw-signature route and atomic event functions | Code complete; external Stripe test-mode evidence missing |
| Real balance, history, subscription, and top-up interfaces | Real wallet/history, Checkout, lifecycle projection, and configured portal action | Code complete; external Stripe test-mode evidence missing |
| Plan/user/concurrency/provider controls and kill switches | Rate cards, system controls, provider budget authorization | Complete locally |
| Server-only gateway with hard ceilings | OpenAI, DeepSeek, and MiniMax adapters; database authorization plus single-dispatch claim | Complete locally; latest retry passed automatic anchoring but failed human semantic quality review |
| Provider-reported usage and actual-cost capture | Token/cache/tool/search/latency/request/cost fields, settlement, and provider-invoice comparison | Code complete; first real provider export/invoice evidence missing |
| Approved lower-cost routing | Versioned approved route table and fail-closed lookup | Mechanism complete; reviewed staging draft remains disabled because quality gate failed |
| Automated financial and provider-invoice reconciliation | Durable daily runner, Stripe comparison, immutable hashed invoice import, internal mismatch functions, and completed manual staging run `9d55511f-f8cc-4387-912e-c3d415611366` | Routes and persistence verified on staging; scheduler-originated run, first real invoice, and Stripe lifecycle still missing |

## Verification evidence

```text
supabase db reset --local --no-seed        pass
supabase db lint --local --level warning   no schema errors
supabase test db --local                   197/197 pass
pnpm test:phase2                           concurrent duplicate/overspend pass
pnpm test:billing-config                   environment/project boundary pass
pnpm test:providers                        OpenAI/DeepSeek/MiniMax contracts pass
pnpm phase2:verify-cron-staging            deployed 401/200 and persisted-run checks pass
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
  at period end, and plan/quantity changes disabled. An active sandbox webhook
  destination now points at the isolated Vercel staging deployment and its
  signing secret is stored server-side only. See
  [`phase-two-stripe-staging-evidence.md`](./phase-two-stripe-staging-evidence.md).
  No real webhook delivery or payment/refund/dispute lifecycle evidence exists
  yet.
- Controlled OpenAI staging evaluations were executed against the uploaded
  developer-owned brief/rubric. The completed saved response failed real
  PDF-page/excerpt anchor validation. After explicit approval, a deterministic
  anchored-text retry completed with 10 requirements and 16 canonical anchors;
  all automatic source/page/text-hash validation checks pass. Human checklist
  review against the real PDFs then failed: 37.5% critical recall, 90% anchor
  accuracy, nine missing critical requirements, three partly correct rows, and
  incomplete coverage. The table parser omitted the visible rubric criteria
  from the provider input. After explicit approval, a table-aware local-OCR v5
  request completed with 26 requirements and 41 anchors and passed automatic
  validation, but human review failed at 66.7% critical recall and 54.8% anchor
  accuracy. Four critical items were missing and seven rows were partly
  correct. After explicit approval, the v6 row-aware request completed with 25
  requirements and 48 materialized anchors and passed every automatic check.
  Its locked semantic review still failed: 58.8% critical-requirement recall
  and 96.4% requirement-anchor accuracy, with six brief/learning-outcome
  requirements omitted, one required ambiguity missed, one unsupported
  completion of truncated rubric text, and two contextual notices promoted to
  requirements. After explicit approval, v7 recovered every previously missing
  learning outcome, instruction, ambiguity, and context classification. Four
  identical coverage rows were safely canonicalized offline without another
  provider request. The semantic review still failed narrowly at 94.1%
  critical recall and 96.3% anchor accuracy because one row completed truncated
  source text with unsupported wording. After explicit approval, one v8 Luna
  comparison completed with 24 requirements and 34 anchors. Automatic
  validation passed, all returned rows were supported, and the prior truncated
  completion was corrected. The locked semantic review still failed because
  all four learning outcomes were misclassified as context-only: critical
  recall fell to 76.5% (13 of 17), although returned-row anchor accuracy was
  100%. The evaluator now has a deterministic guard that prevents the two
  numbered, student-directed action blocks from passing as context-only. One
  approved post-fix Luna request returned HTTP 200 without a completed response
  and was rejected; no retry or mini fallback occurred. The next offline
  contract also requires low confidence, student confirmation, and an ambiguity
  for any requirement based on incomplete source text. The route remains
  unapproved. Non-secret
  metrics and the decision
  are recorded in
  [`phase-two-provider-decision-evidence.md`](./phase-two-provider-decision-evidence.md).
- The owner rejected GPT-5.6 Sol on cost and selected `gpt-5.6-luna` for one
  controlled comparison, with the failed `gpt-5.4-mini-2026-03-17` result
  retained only as a manual technical fallback. The Luna request used the
  exact v7 prompt/schema and locked checklist, `reasoning.effort: none`,
  `store: false`, and no tools/search. It took 14,527 ms, used 5,062 input,
  5,059 cache-write input, and 3,492 output tokens, and was estimated at USD
  0.0273. The comparable completed mini request cost USD 0.0202 and came much
  closer to the locked recall threshold, so mini is the recommended next
  controlled candidate, not an approved route. One subsequently approved
  guarded mini request completed for USD 0.0209. Both new safety guards passed,
  but automatic coverage validation failed because one of 27 required anchors
  was missing and two rubric anchors had conflicting duplicate classifications.
  The private report was retained, semantic review was blocked, and no retry or
  fallback request was made. The array-shaped coverage receipt has now been
  replaced offline by a strict object with all 27 anchor IDs as required unique
  properties. After explicit approval, one v11 mini request used this contract
  and returned every required anchor exactly once. A shape-only null-metadata
  anchor was removed by a deterministic offline canonicalizer, after which all
  automatic checks passed without another provider request. The locked human
  review nevertheless failed: critical recall was 88.2% (15 of 17) and anchor
  accuracy was 96.3% (26 of 27). One critical country-impact purpose was
  omitted and one truncated rubric fragment was completed with unsupported
  wording. Mini therefore remains unapproved. The offline v13 contract now
  creates five deterministic complete atomic clauses, binds the exact text and
  hash of each clause into the strict schema, and requires a different
  one-clause requirement for every receipt. It independently marks the
  truncated OCR block, emits no atomic clause from it, prohibits that block
  from all semantic extraction, and permits only one fixed neutral ambiguity.
  Regression tests reject merged or omitted clauses and any guessed completion.
  The v13 isolated-staging dry run passes with no provider request; v13 is not
  yet provider quality evidence and its checklist still needs versioned review.
  The evaluator now also requires an explicit private
  `provider_request_approval` block bound to the exact staging project, model,
  prompt, schema, anchoring version, and document hashes before any paid
  provider request can run.
  Because the quality gate failed and
  the billing schema cannot yet price cache-write tokens separately, both
  routes and all controls remain disabled and unapplied.
- The Stripe Sandbox catalog now matches the reviewed configuration exactly for
  both product keys, amounts, billing modes, grants, and expiry. A guarded
  metadata repair updated only the four mismatched sandbox product-key fields;
  compensating rollback was available, read-back passed, and an immediate
  read-only rerun found zero pending changes. Deployment
  `dpl_DXAqB56QpptwmrLnj7RcYdchJXt5` also returns HTTP 400 for both missing and
  invalid webhook signatures, independently confirmed by Vercel runtime logs.
  These are configuration and rejection-path facts, not financial lifecycle
  evidence. Test-mode Checkout, valid signed webhook delivery, portal
  cancellation, retry/dunning, refund, dispute, duplicate delivery, and
  financial reconciliation are still required.
- The staging production deployment now has real cron-route evidence. Browser
  GET requests to maintenance and reconciliation returned 401. Authenticated
  POSTs returned 200; maintenance had no failures, and reconciliation persisted
  completed run `9d55511f-f8cc-4387-912e-c3d415611366` with six internal
  checks and zero issues. Vercel runtime logs independently show all four
  requests. This was a manual authenticated verification, not a scheduler
  trigger. The deployment missed the 2026-07-20 UTC windows, so scheduler-
  originated evidence remains required from the next eligible daily windows.
  See [`phase-two-cron-staging-evidence.md`](./phase-two-cron-staging-evidence.md).
- Provider invoice reconciliation has a real import path but cannot be proven until a real provider export/invoice is supplied. Network failures with no provider-reported usage rely on this comparison to discover a late provider charge.
- A private, outside-repository staging configuration draft now contains the
  approved Stripe products, credit grants/expiry, Luna and mini OpenAI price snapshots,
  margin/FX controls, and operational limits. Its provider route and all four
  controls remain disabled. Secret-safe preflight passes the isolated Supabase
  target, Stripe test mode, and required server-secret checks, then correctly
  blocks because there is no approved provider route. Nothing was applied, so
  the previously verified empty staging configuration remains unchanged.
- Secret-safe local inspection on 2026-07-20 found `.env.local` still targets the shared production Supabase URL and does not define the Phase 2 service-role, Stripe, cron, target, or provider variables. It must not be used for staging evidence; configure a separate staging environment without committing or printing secret values.
- No Phase 2 migration has been applied to the linked shared production database. Production promotion still requires explicit approval after the external staging gate.
- No student-facing AI feature invokes the gateway yet. Phase 3’s real requirement-analysis slice is the first intended low-risk feature.

## Release decision

Keep Phase 2 disabled in production. Sandbox connection, real Aido
products/prices, the cancellation-only portal configuration, isolated staging
deployment, and sandbox webhook/server-secret configuration are complete. The
remaining Phase 2 exit gate is external and configuration-specific: complete
the provider quality gate with a materially safer extraction approach,
enable/review the currently disabled configuration,
and apply it atomically; perform the first
real provider response and invoice/export comparison; and pass the full
Checkout/subscription/refund/dispute/cron evidence set. Then review the
additive production migration set separately.
