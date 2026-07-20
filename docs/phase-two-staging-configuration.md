# Phase 2 staging configuration gate

> Date: 2026-07-20
> Rule: no placeholder products, prices, credit grants, model rates, or API calls

## Current state

The isolated Supabase staging schema is ready. All paid paths still fail closed
because the tables contain no effective billing configuration, credit products,
provider prices, approved routes, or enabled system controls.

Stripe is connected to the isolated `AidoForMe` sandbox account
`acct_1Tv6yz1tdTVob40G`. The two approved products/prices and the restricted
customer portal configuration have been created and verified with
`livemode: false`. See
[`phase-two-stripe-staging-evidence.md`](./phase-two-stripe-staging-evidence.md).
The sandbox still has no webhook endpoint, and no payment lifecycle test has
been run.

## Decisions required before external tests

1. Approve each Aido top-up and subscription price in MYR and the exact credits
   granted by each purchase or renewal.
2. Approve the minimum top-up, target gross margin, payment-risk reserve, quote
   safety multiplier, and conservative MYR/USD budget rate.
3. Approve each provider/model route after price-source, quality, privacy, and
   data-retention review. A route is unusable until its `approved` flag and all
   global/feature/provider/model controls are enabled.
   The current OpenAI evidence and unresolved pricing/privacy issues are recorded
   in [`phase-two-provider-decision-evidence.md`](./phase-two-provider-decision-evidence.md).
4. ~~Connect Stripe sandbox mode and create Aido-only test products/prices.~~
   Complete; exact IDs and terms are recorded in the Stripe evidence note.
5. ~~Create a Stripe portal configuration that enables payment-method updates and
   cancellation at period end, while disabling subscription price and quantity
   changes.~~ Configuration `bpc_1Tv93i1tdTVob40Gc9FMuhaa` is verified; its ID
   still needs to be present as `STRIPE_PORTAL_CONFIGURATION_ID` in each staging
   server environment.
6. Configure the staging webhook for:
   `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `customer.subscription.paused`,
   `customer.subscription.resumed`, `refund.created`, and
   `charge.dispute.created`.
7. Set only server-side secrets: `SUPABASE_SERVICE_ROLE_KEY`,
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CRON_SECRET`,
   `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, and `MINIMAX_API_KEY` as required by
   the approved routes. Never prefix them with `NEXT_PUBLIC_`.

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
- One real provider response records tokens, cached input, output, tools/search,
  latency, request ID, and actual provider cost.
- One real provider invoice/export is imported by hash and reconciles to recorded
  usage, or produces a durable critical issue.
- The scheduled reconciliation route creates a completed run and the browser
  cannot invoke it without `CRON_SECRET`.
- The scheduled maintenance route releases overdue reservations, expires due
  unreserved lots, and the browser cannot invoke it without `CRON_SECRET`.
- Security/performance advisors, `scripts/audit-phase-two-schema.sql`, database
  tests, concurrency tests, no-demo check, lint, typecheck, and build all pass.

Vercel invokes configured cron paths only for production deployments, so the
staging Vercel project needs its own production deployment. Stripe portal
features are controlled by the selected portal configuration; disabling
subscription updates prevents unsupported price/quantity changes.

References:

- [Vercel cron job configuration](https://vercel.com/docs/cron-jobs/quickstart)
- [Stripe customer portal configuration](https://docs.stripe.com/customer-management/configure-portal)
- [Stripe portal session API](https://docs.stripe.com/api/customer_portal/sessions/create)
