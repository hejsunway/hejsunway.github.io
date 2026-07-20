# AidoFor.me Phase 2 to Phase 3 Handoff

> Date: 2026-07-20
> Purpose: durable context for a separate Codex task
> Decision: Phase 2 is code-complete but **not exit-gate complete**; finish its real external staging evidence before implementing Phase 3

## Governing documents

Read these before changing code. The production implementation plan controls
engineering phase numbering and gates; the PRD controls product scope.

1. [`implementation-plan.md`](./implementation-plan.md)
2. [`aidofor-me-prd.md`](./aidofor-me-prd.md)
3. [`credit-usage-and-margin-control.md`](./credit-usage-and-margin-control.md)
4. [`assignment-autopilot.md`](./assignment-autopilot.md)
5. [`phase-two-progress-audit.md`](./phase-two-progress-audit.md)
6. [`phase-two-staging-configuration.md`](./phase-two-staging-configuration.md)
7. [`phase-two-provider-decision-evidence.md`](./phase-two-provider-decision-evidence.md)
8. [`phase-two-stripe-staging-evidence.md`](./phase-two-stripe-staging-evidence.md)
9. [`billing-configuration.schema.json`](./billing-configuration.schema.json)
10. [`workspace-design-direction.md`](./workspace-design-direction.md)
11. [`shared-auth-setup.md`](./shared-auth-setup.md)

## Non-negotiable delivery rules

- No demo, seed, placeholder, fabricated, or silent fallback data in the
  authenticated product. Honest empty, unavailable, paused, and failed states
  are required.
- Phase completion is evidence-based. Do not begin Phase 3 implementation until
  every Phase 2 exit item below has real staging evidence.
- Never expose Supabase service-role, Stripe, provider, or cron secrets to the
  browser, logs, source control, chat, or `NEXT_PUBLIC_*` variables.
- All financial values use integer units. The browser never chooses prices,
  credits, provider/model routes, or wallet mutations.
- All provider calls go through the server-only metered gateway and require an
  immutable reservation, provider authorization, hard limits, usage capture,
  and settlement/release behavior.
- Preserve the user's existing uncommitted work. Do not revert unrelated
  changes, reset the worktree, or modify TutorPakar-owned database objects.
- Use additive Aido-scoped migrations only. Explicit Data API grants and RLS
  are separate controls and both must be tested.
- Do not mutate the shared production Supabase project without a new explicit
  user approval after staging passes.

## Environment boundaries

| Environment | Identifier | Rule |
|---|---|---|
| Aido staging | `vokjkogzvtohdinhxhkk` | Approved integration target; Singapore (`ap-southeast-1`), free plan |
| Shared TutorPakar production | `gmqlmqdqpytgjxolgrwq` | Read-only unless separately and explicitly approved |
| Supabase organization | `ixzathktlmmtravlopyh` | TutorPakar organization |

The local Supabase CLI may still be linked to the shared production project.
Never rely on the implicit link for remote commands. Resolve and pass the
staging project explicitly, and perform destructive tests only against the
isolated local database.

## Phase 2 status

### Completed mechanisms

- Versioned billing configuration, provider prices, feature rate cards,
  provider routes, credit products, and global/feature/provider/model controls.
- Non-negative wallets, expiring lots, append-only ledger, reservations,
  allocations, usage events, payment events, reversals, and account freezes.
- Service-only atomic grant, reserve, authorize, dispatch, usage recording,
  settlement, release, expiry, refund, dispute, and reconciliation operations.
- Exactly-once/idempotency protections for material financial and provider
  actions, including crash-safe one-way provider dispatch claims.
- Durable reconciliation for ambiguous dispatches and late provider invoices.
- Fixed-endpoint adapters for OpenAI Responses, DeepSeek Chat Completions, and
  MiniMax Chat Completions behind one server-only gateway.
- Stripe Checkout, raw-body webhook verification, test/live mode guard,
  subscription projection, refund/dispute reversal, and customer portal action.
- Secret-protected scheduled maintenance and reconciliation routes.
- Real billing interface with honest unavailable/empty states.
- Atomic, hash-journaled billing configuration import with no bundled values.
- Immutable provider invoice import and reconciliation path.
- Billing configuration preflight and apply are bound to the approved Supabase
  project ref for each environment, with a regression test that rejects a
  staging-labelled import pointed at the shared production project.

### Verified evidence at handoff

- Staging project status: `ACTIVE_HEALTHY`.
- Staging contains all Phase 1 migrations and nine Phase 2 migrations through
  `aido_phase_two_scheduled_expiry`.
- Staging security and performance advisors have no warning/error findings;
  informational deny-by-default policy and unused-index notices are expected in
  the empty staging database.
- Staging currently contains zero billing configuration imports, billing
  configs, provider prices, feature rate cards, provider routes, credit
  products, system controls, wallets, usage events, provider authorizations,
  provider invoice imports, and payment events.
- Local database verification previously passed 197/197 pgTAP assertions plus
  concurrent duplicate/overspend tests.
- On 2026-07-20, `pnpm check` passed: no-demo scan, provider adapter contracts,
  ESLint, TypeScript, and the Next.js production build.

## Remaining Phase 2 exit gate

Phase 2 is not done until all of the following are executed with real staging
services and preserved as evidence:

1. Approve real Aido MYR top-up/subscription prices and exact credit grants.
2. Approve the net-credit revenue floor, margin target, payment-risk reserve,
   quote multiplier, conservative MYR/USD rate, and operational limits.
3. Approve at least one provider/model route using current official pricing,
   privacy, retention, regional availability, and quality evidence.
4. Prepare a reviewed configuration JSON outside the repository using
   `billing-configuration.schema.json`; do not invent defaults.
5. Connect Stripe sandbox/test mode. Do not write to the currently connected
   live TutorPakar Stripe resources.
6. Create Aido-only Stripe test products and prices plus a cancellation-only
   customer portal configuration. Allow payment-method updates and cancellation
   at period end; disable plan/price and quantity changes.
7. Configure the staging Stripe webhook events listed in
   `phase-two-staging-configuration.md`.
8. Configure staging server secrets without pasting their values into chat:
   `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY`,
   `STRIPE_WEBHOOK_SECRET`, `STRIPE_PORTAL_CONFIGURATION_ID`, `CRON_SECRET`,
   `AIDO_BILLING_CONFIG_TARGET=staging`, and only the provider API keys used by
   approved routes (`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, or
   `MINIMAX_API_KEY`). The public Supabase URL must target
   `https://vokjkogzvtohdinhxhkk.supabase.co`.
9. Run the secret-safe preflight and atomically apply the reviewed configuration:

   ```bash
   pnpm phase2:preflight \
     --environment staging \
     --project-ref vokjkogzvtohdinhxhkk \
     --config /absolute/path/reviewed-config.json

   AIDO_BILLING_CONFIG_TARGET=staging \
   pnpm billing:config /absolute/path/reviewed-config.json --apply
   ```

10. Produce real staging evidence for:
    - one settled top-up and exactly one credit lot;
    - duplicate webhook idempotency;
    - subscription activation, paid renewal, failed renewal, and cancellation;
    - refund and dispute compensation without a negative wallet;
    - insufficient-credit denial before any provider network request;
    - concurrent reservation safety;
    - one real provider response with complete usage/cost/request trace;
    - one real provider export/invoice import and reconciliation result;
    - authenticated cron maintenance and reconciliation plus browser denial;
    - final schema audit, advisors, database tests, concurrency tests,
      no-demo scan, lint, typecheck, and build.

Only after this evidence passes should `phase-two-progress-audit.md` be updated
to declare the Phase 2 exit gate complete. Production migration remains a
separate decision and is not required to start Phase 3 in isolated staging.

## How the new task should work

1. Re-read the governing documents and inspect the current dirty worktree.
2. Re-run safe local checks and read-only staging audits; do not repeat completed
   work without evidence of regression.
3. Finish every safe Phase 2 task that does not require user-supplied secrets or
   pricing decisions.
4. For external configuration, ask only for the missing decision or for the
   user to configure a secret in their environment. Never ask them to paste a
   secret into chat.
5. Once the external gate passes, record exact evidence and mark Phase 2
   complete in the audit.
6. Then begin Phase 3 in production-backed vertical slices, using real files
   owned by the developer's staging account and no customer/demo data.

## Phase 3 implementation plan

### Gate 3.0 — architecture and current-service verification

- Verify current Supabase Queues/`pgmq`, Storage, Realtime, and worker guidance
  against official documentation and the staging project versions.
- Decide the durable worker runtime for multi-minute parsing/OCR. Do not hold
  document processing inside a browser or long page request.
- Approve actual parsers/OCR services, their licenses, size/page limits,
  sandboxing, privacy, retention, cost, and failure behavior before installation.
- Define versioned structured schemas for parsing output and requirement
  extraction before making provider calls.

### Slice 3.1 — durable ingestion schema and authorization

- Add Aido-scoped jobs/attempts, document versions, extracted pages/sections,
  chunks, parser runs, requirement extraction runs, requirement rows, and
  confirmation/revision history.
- Store content hashes, source document/version, page/section anchors, parser
  version, extraction version, prompt/schema version, confidence, status,
  timestamps, idempotency keys, reservation/usage linkage, and failure codes.
- Enforce owner/project-member RLS for readable project data. Only trusted
  workers may claim jobs, advance state, or write canonical extraction results.
- Explicitly test anonymous, owner, unrelated user, and service-worker access.

### Slice 3.2 — validation, parsing, and OCR worker

- Enqueue real uploaded assignment documents from Phase 1.
- Validate MIME and magic bytes, malware-scan, cap file/page/decompression size,
  hash content, and detect duplicates before expensive work.
- Route PDF, DOCX, image/scanned PDF, and text to approved parsers/OCR.
- Persist source-anchored output and visible confidence/errors.
- Implement bounded retry, cancellation, lease expiry, crash recovery, and
  idempotent resume without duplicate charges.

### Slice 3.3 — metered requirement extraction

- Reserve credits before calling the Phase 2 gateway.
- Extract command verbs, deliverables, constraints, weights, required
  theories/cases, source rules, format, learning outcomes, ambiguities, and
  policy signals into the versioned schema.
- Validate every output. A requirement without a real document/page/location
  anchor is invalid; invented requirements must never be persisted as success.
- Record reservation, authorization, dispatch, provider request, usage/cost,
  prompt version, schema version, validation outcome, settlement, and release.

### Slice 3.4 — student requirement confirmation UI

- Replace the Phase 1 “setup complete” endpoint with real processing progress,
  failure/retry/cancel states, and an editable source-anchored requirement matrix.
- Let the student open the exact document location, edit interpretation/status,
  flag ambiguity, and confirm the integrity mode and requirement set.
- Lock later workflow stages until the server records confirmation.
- Match `workspace-design-direction.md`: calm, clean, sparse, Codex/Gemini-like,
  responsive, accessible, and consistent with the Aido landing brand.

### Slice 3.5 — verification and Phase 3 exit evidence

- Test refresh, sign-out/sign-in, browser closure, worker restart, cancellation,
  duplicate upload, parser failure, OCR uncertainty, provider timeout, invalid
  structured output, insufficient credits, and malicious direct Data API calls.
- Demonstrate one real brief and rubric producing a persisted, editable,
  source-anchored matrix with no fabricated requirement.
- Prove duplicate-safe derived-work reuse and complete provider/credit lineage.
- Run local reset, database/RLS/integration tests, staging schema audit,
  advisors, no-demo scan, lint, typecheck, build, and responsive/accessibility
  verification.
- Update durable docs with the actual service choices, limits, evidence, and
  remaining risks. Do not mark Phase 3 complete from UI rendering alone.

## Phase 3 definition of success

A developer-owned real brief and rubric can be uploaded in staging, processed
asynchronously, resumed after browser or worker interruption, and converted
through the metered gateway into an editable requirement matrix where every row
opens its real source location. The student confirms the requirements and
integrity mode, all credit/provider activity is traceable and bounded, unrelated
users cannot access any row/object, and no placeholder or invented success data
is shown.
