# Phase 2 staging configuration gate

> Date: 2026-07-22
> Rule: no placeholder products, prices, credit grants, model rates, or API calls

## Current state

The isolated Supabase staging schema is ready. A real private configuration
draft exists outside the repository, but it has not been applied. All paid paths
still fail closed because the tables contain no effective billing
configuration, credit products, provider prices, approved routes, or enabled
system controls.

The cache-write accounting migration is now live on isolated staging. A
read-only PostgREST probe confirms both new columns and the replacement usage
RPC signature; the provider-price and usage tables still contain zero rows.
The staging migration ledger was normalized only after all 13 alternate-
timestamp remote statements matched the canonical repository files byte for
byte. The connected Supabase plugin independently confirms the exact staging
project is healthy and all 14 canonical migrations are present. Hosted
advisors report one warning: leaked-password protection is disabled. The
signed-in staging dashboard confirms that this control is Pro-only while this
isolated project is on Free; no plan or billing change was made. No shared-
production schema or data was changed.

Stripe is connected to the isolated `AidoForMe` sandbox account
`acct_1Tv6yz1tdTVob40G`. The two approved products/prices and the restricted
customer portal configuration have been created and verified with
`livemode: false`. See
[`phase-two-stripe-staging-evidence.md`](./phase-two-stripe-staging-evidence.md).
An active sandbox webhook now delivers to the isolated Vercel staging project;
no payment lifecycle test has been run yet.

## Decision and gate state before external tests

1. ~~Approve each Aido top-up and subscription price in MYR and the exact
   credits granted by each purchase or renewal.~~ Complete.
2. ~~Approve the minimum top-up, target gross margin, payment-risk reserve,
   quote safety multiplier, and conservative MYR/USD budget rate.~~ Complete.
3. Approve each provider/model route only after price-source, quality, privacy, and
   data-retention review. A route is unusable until its `approved` flag and all
   global/feature/provider/model controls are enabled.
   The deterministic anchored-text evaluations pass automatic grounding, but
   the required human reviews failed. The latest table-aware v5 result reached
   66.7% critical recall and 54.8% anchor accuracy because some OCR rubric rows
   were split across anchors and four critical items remained missing. The v6
   row-aware request subsequently passed every automatic check, but its locked
   semantic review failed at 58.8% critical-requirement recall despite 96.4%
   requirement-anchor accuracy. Missing brief/learning-outcome requirements,
   an unreported ambiguity, and partial/contextual rows prevent approval. The
   v7 source-coverage request then recovered all previously missing items and
   reached 94.1% critical recall and 96.3% anchor accuracy, but one unsupported
   completion of truncated rubric text still fails the no-partial-row rule. The
   owner then approved exactly one `gpt-5.6-luna` comparison after rejecting
   Sol's cost. Luna corrected the unsupported truncated-text completion and all
   24 returned rows had valid anchors, but it misclassified both
   learning-outcome source blocks as context-only and omitted all four critical
   outcomes. The locked review therefore failed at 76.5% critical recall even
   though returned-row anchor accuracy was 100%. A deterministic structural
   guard now prevents those two action blocks from passing as context-only, but
   the one approved post-fix Luna request returned HTTP 200 without a completed
   response and was rejected. No retry or fallback call occurred. The next
   offline contract also guards requirements sourced from incomplete text.
   GPT-5.4 mini remains unapproved, but its 94.1% recall and lower measured cost
   made it the recommended next controlled candidate. The one approved guarded
   mini request then passed both new safety guards but failed automatic coverage
   validation: one required anchor was missing and two rubric anchors had
   conflicting duplicate classifications. Human review was therefore blocked.
   The coverage receipt is now a strict object with all 27 anchor IDs required
   exactly once. One approved v11 mini request proved that contract and passed
   every automatic check after an offline, content-neutral normalization of one
   null metadata anchor. The human review still failed at 88.2% critical recall
   and 96.3% anchor accuracy: one critical country-impact purpose was omitted
   and one truncated rubric fragment was completed with unsupported wording.
   The mini route therefore remains unapproved. The offline v13 contract now
   binds the exact text and hash of five deterministic complete atomic clauses
   into the strict schema and requires a separate one-clause requirement for
   each receipt. The independently detected truncated rubric block produces no
   clause, cannot anchor semantic output, and may appear only in one fixed
   neutral ambiguity. Regression tests and an isolated-staging dry run pass
   without a provider request. A private version-bound 17-item v13 checklist
   exists outside Git with mode `0600` and SHA-256
   `3ee2e0dc9d71b53cc3c190aed861cfc7ca090ac10bb151a637715c105d4d1324`.
   Its exact-scope `provider_request_approval` remains `false`; a paid v13
   evaluation still requires review and separate explicit approval.
   Distinct cache-write pricing and usage accounting is now implemented and
   deployed to isolated staging. The reviewed draft still keeps both routes
   and all controls disabled because the v13 provider quality gate has not
   passed and its worst-case route ceiling must be reviewed against the
   cache-write price. Evidence is
   recorded
   in [`phase-two-provider-decision-evidence.md`](./phase-two-provider-decision-evidence.md).
4. ~~Connect Stripe sandbox mode and create Aido-only test products/prices.~~
   Complete; exact IDs and terms are recorded in the Stripe evidence note. A
   guarded verifier also corrected the four legacy product-key metadata values
   and an immediate read-only rerun found no remaining catalog mismatch.
5. ~~Create a Stripe portal configuration that enables payment-method updates and
   cancellation at period end, while disabling subscription price and quantity
   changes.~~ Configuration `bpc_1Tv93i1tdTVob40Gc9FMuhaa` is verified; its ID
   is configured as `STRIPE_PORTAL_CONFIGURATION_ID` in the isolated staging
   server environment.
6. ~~Configure the staging webhook for:
   `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `customer.subscription.paused`,
   `customer.subscription.resumed`, `refund.created`, and
   `charge.dispute.created`.~~ Complete: the active destination and its
   non-secret identifier are recorded in the Stripe evidence note. The deployed
   endpoint returns HTTP 400 for missing and invalid signatures; this does not
   replace the still-required valid signed lifecycle delivery.
7. ~~Set only server-side secrets: `SUPABASE_SERVICE_ROLE_KEY`,
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CRON_SECRET`,
   `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, and `MINIMAX_API_KEY` as required by
   the approved routes.~~ The staging-required values are present and the
   secret-safe preflight reports only their status. Never prefix them with
   `NEXT_PUBLIC_`.

The 2026-07-20 preflight passes the exact staging project ref/URL, billing
target, Supabase service credential presence, Stripe test-mode key, webhook
secret, portal configuration ID, and cron secret. It correctly reports
`ready: false` because `assignment.requirement_extraction` has no approved
provider route. No configuration import was attempted.

## Configuration application

The repository contains no example prices, placeholder models, or fallback
credit grants. Use the value-free
[`billing-configuration.schema.json`](./billing-configuration.schema.json) in
your editor, prepare a reviewed JSON file outside the repository, then run:

```bash
pnpm billing:config /absolute/path/reviewed-config.json
```

Validation is read-only. It rejects unknown/missing fields, unsupported
providers, unfunded credit products, routes without all four control scopes,
provider ceilings above the minimum-charge margin, and maximum route usage
above its declared provider ceiling.

Only after review, target the isolated staging environment and apply the exact
same file atomically:

```bash
AIDO_BILLING_CONFIG_TARGET=staging \
pnpm billing:config /absolute/path/reviewed-config.json --apply
```

The command requires staging Supabase server credentials. It hashes the source,
journals the import, and uses one database transaction; the same digest is
idempotent and a failed validation leaves no partial prices, products, routes,
or controls. The importer independently requires the Supabase URL to match the
approved project for the declared environment, so a staging-labelled import
cannot be sent to the shared production project by mismatched environment
variables. Production additionally requires `--confirm-production` and still
requires explicit deployment approval.

Before any external test, run the secret-safe preflight. It reports only
`set`, `missing`, or mode/target mismatches and never prints credential values:

```bash
pnpm phase2:preflight \
  --environment staging \
  --project-ref vokjkogzvtohdinhxhkk \
  --config /absolute/path/reviewed-config.json
```

Only API keys used by an approved route are required. A staging preflight
rejects live Stripe keys and a production preflight rejects test keys. It also
requires the declared environment, project ref, public Supabase URL, and
`AIDO_BILLING_CONFIG_TARGET` to agree before reporting ready.

## Required exit evidence

- One test top-up grants exactly one lot after a settled signed webhook.
- Duplicate webhook delivery produces one financial effect.
- One test subscription projects active status, grants only from `invoice.paid`,
  records a failed renewal, and reflects cancellation at period end.
- A refund and dispute produce compensating entries and freeze unrecovered
  exposure without making the wallet negative.
- An insufficient balance blocks the provider call before network access.
- Concurrent reservations cannot overspend one wallet.
- One real provider response records ordinary input, cache-read input,
  cache-write input, output, tools/search, latency, request ID, and the
  database-recomputed actual provider cost.
- One real provider invoice/export is imported by hash and reconciles to recorded
  usage, or produces a durable critical issue.
- The scheduled reconciliation route creates a completed run and the browser
  cannot invoke it without `CRON_SECRET`.
- The scheduled maintenance route releases overdue reservations, expires due
  unreserved lots, and the browser cannot invoke it without `CRON_SECRET`.
- Security/performance advisors, `scripts/audit-phase-two-schema.sql`, database
  tests, concurrency tests, no-demo check, lint, typecheck, and build all pass.

Manual authenticated staging verification now proves both deployed routes
return 401 without the secret and 200 with it. Maintenance completed with no
failures, and reconciliation persisted completed run
`9d55511f-f8cc-4387-912e-c3d415611366` with zero issues. This does not replace
the still-missing Vercel scheduler-originated run. See
[`phase-two-cron-staging-evidence.md`](./phase-two-cron-staging-evidence.md).

Vercel invokes configured cron paths only for production deployments, so the
staging Vercel project needs its own production deployment. Stripe portal
features are controlled by the selected portal configuration; disabling
subscription updates prevents unsupported price/quantity changes.

References:

- [Vercel cron job configuration](https://vercel.com/docs/cron-jobs/quickstart)
- [Stripe customer portal configuration](https://docs.stripe.com/customer-management/configure-portal)
- [Stripe portal session API](https://docs.stripe.com/api/customer_portal/sessions/create)
