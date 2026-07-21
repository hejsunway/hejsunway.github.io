# Credit Usage and Margin Control

> **Status:** Billing and architecture decision record  
> **Date:** 2026-07-19  
> **Scope:** Prepaid usage control for all metered AidoFor.me features  
> **Related:** [Main PRD](./aidofor-me-prd.md), [Assignment Autopilot](./assignment-autopilot.md)

## Decision

AidoFor.me uses a **prepaid credit wallet with two-phase reservation and settlement**. A provider call must not begin until the server has authenticated the student, calculated a versioned quote, confirmed policy and feature limits, and atomically reserved enough credits for the maximum permitted job cost.

The system protects variable margin and bounds abuse. It cannot by itself guarantee company profitability because fixed infrastructure, salaries, support, tax, marketing, fraud, and refund volume still require business monitoring and sufficient paid customers.

## Non-negotiable rules

- The browser never supplies the price, provider cost, model, balance mutation, or payment truth.
- Credits are integers; MYR is stored in sen; provider USD cost is stored in micro-dollars. Do not use floating-point money.
- Every grant, reservation, capture, release, refund, expiry, reversal, and adjustment creates an append-only ledger entry.
- No wallet may become negative.
- Every external job and payment webhook has a unique idempotency key.
- Provider secrets and the Supabase service-role key remain server-only.
- Users may read only their own wallet and ledger rows. Users cannot directly insert ledger entries or update wallet balances.
- Provider spending is checked before every external call, not only when a job starts.
- Failed output is not charged to the student. Aido records the provider expense as operational loss and permits at most one controlled retry by default.

## Usage pipeline

```text
request feature
-> authenticate and authorize
-> validate integrity mode and feature limits
-> measure words/pages/sources/search breadth
-> choose allowed provider route
-> estimate maximum landed provider cost
-> calculate versioned credit quote
-> atomically reserve maximum credits
-> enqueue idempotent background job
-> check remaining cost budget before each provider call
-> execute with hard token/tool/search/page limits
-> record provider-reported actual usage
-> capture actual credits
-> release unused reservation
-> deliver artifact
```

If the next step may exceed the job's maximum credits or provider-cost ceiling, the worker pauses and requests explicit approval for a new quote. It never silently overspends.

## Logical data model

| Entity | Purpose | Important constraints |
|---|---|---|
| `aido_credit_wallets` | Cached available and reserved balance | One row per user; non-negative checks |
| `aido_credit_ledger` | Permanent source of financial truth | Append-only; unique idempotency key |
| `aido_usage_reservations` | Quote and maximum exposure for one job | Unique job key; explicit lifecycle |
| `aido_usage_events` | Actual model, ordinary/cache-read/cache-write token, search, page, latency, and provider cost | Unique provider request ID where available; cache subsets cannot exceed total input |
| `aido_feature_rate_cards` | Versioned retail rules and job limits | Effective dates; immutable historical versions |
| `aido_provider_prices` | Versioned ordinary input, cache-read, cache-write, output, and tool unit costs | Currency and effective dates; immutable historical versions |
| `aido_payment_events` | Verified Stripe event processing | Unique Stripe event ID |
| `aido_plan_grants` | Subscription/semester/top-up credit lots | Source, granted amount, remaining amount, expiry |

The ledger is canonical. The wallet is a transactionally maintained projection for fast balance checks. Reconciliation must be able to rebuild or verify wallet totals from ledger entries.

### Reservation lifecycle

```text
reserved -> running -> settled
                    -> released
                    -> failed/released
                    -> expired/released
```

A run waiting for a student may retain only the small amount required to resume imminently; otherwise unused credits are released and re-reserved after the answer.

## Atomic operations

### Reserve

Within one database transaction:

1. Lock the student's wallet row.
2. Reject duplicate idempotency keys by returning the original reservation.
3. Confirm `available_credits >= maximum_credits`.
4. Move the amount from available to reserved.
5. Insert the reservation and ledger record.
6. Commit.

### Settle

Within one database transaction:

1. Lock the reservation and wallet.
2. Confirm the reservation is settleable and has not already settled.
3. Capture the calculated credits, never more than reserved.
4. Return the unused difference to available credits.
5. Insert capture and release ledger records.
6. Mark the reservation settled.
7. Commit.

### Release

Release is idempotent. It returns the remaining reserved balance, writes a release ledger entry, and moves the reservation to a terminal state. Repeated release requests return the existing result without another balance mutation.

These operations run only in trusted server code. If privileged database functions are required for atomicity, keep them in a non-exposed schema, revoke default `PUBLIC` execution, explicitly grant only the trusted role, validate the authenticated user or trusted job identity, and test the privilege boundary. Do not place a broadly callable `SECURITY DEFINER` wallet function in `public`.

## Pricing and margin formula

Customer-facing positioning may use:

```text
100 Aido Credits = RM1 of retail usage value
```

Internal economics must use the lowest expected **net revenue per credit** after plan discounts and payment fees. The current conservative working floor is:

```text
1 credit = RM0.008 net revenue
```

Target landed variable provider cost is at most 20% of net credit revenue:

```text
maximum provider cost RM
  = reserved credits x RM0.008 x 0.20
```

For a 1,500-credit Standard Autopilot job:

```text
net revenue basis    = 1,500 x RM0.008 = RM12.00
provider-cost ceiling = RM12.00 x 20%  = RM2.40
```

Quote calculation:

```text
estimated landed cost
  = estimated provider cost
  x budgeted USD/MYR rate
  x 1.35 safety multiplier
  + per-job variable infrastructure

required net revenue
  = estimated landed cost / 0.20

credits
  = ceil(required net revenue / RM0.008)
```

The rate card rounds up to a simple customer price. The budgeted exchange rate, safety multiplier, cost target, and net-credit floor are configuration values with effective dates, not prompt constants.

## Provider-call guard

Before every external call, the worker estimates the next call and verifies:

```text
estimated next cost <= remaining provider-cost budget
estimated next tokens <= step token limit
tool calls <= step tool-call limit
search calls <= job search limit
processed pages <= quoted page limit
retry count <= retry limit
```

At 80% of the provider-cost ceiling, the worker should prefer cached data or an approved lower-cost route and avoid starting an optional expensive pass. At 100%, it must stop and request a new quote.

Provider-reported usage is recorded separately from credits charged. This allows finance and product teams to compare retail revenue, net revenue, provider COGS, failed-job loss, and gross margin by feature, plan, model, and customer cohort.

Prompt-cache reads and writes are separate usage classes. Before dispatch, the
gateway reserves against the highest configured input-token price because the
exact cache outcome is not yet known. After the response, it records each
class separately, and the database recomputes the expected micro-dollar cost
from the immutable provider-price snapshot. A caller-supplied cost that does
not match that calculation is rejected.

## Payment and credit-grant pipeline

Credits are granted only after a verified payment-provider webhook:

```text
receive webhook
-> verify signature
-> reject or return an already-processed event ID
-> map the payment customer to an Aido user
-> validate amount, currency, product, and payment state
-> insert payment event
-> create the credit lot and grant ledger entry
-> update wallet
-> commit atomically
```

The checkout success page is not payment proof. Refunds and chargebacks create reversal ledger entries; they do not rewrite the historical grant. If consumed credits cannot be reversed without a negative balance, freeze new paid jobs and send the account to support review.

Spend promotional and soonest-expiring subscription credits before longer-lived purchased top-up credits, subject to the final legal/accounting treatment of expiry in each market.

## Initial controls

- Minimum top-up: RM20, to reduce fixed payment-fee impact.
- Per-user daily credit limit and concurrent-job limit.
- Platform-wide daily provider budget and emergency kill switch.
- Per-provider and per-model kill switches.
- One paid provider retry by default.
- Input, output, page, source, search, tool-call, and wall-time limits on every feature.
- Content-hash caching for parsed documents, metadata, embeddings, and eligible search results.
- Versioned price snapshots on every reservation.
- A 35% FX, estimate, and provider-price buffer in preflight quoting.
- A separate 3-5% revenue reserve for failures, refunds, fraud, and disputes.
- Alerts when seven-day landed provider cost exceeds 20% of net credit revenue or when any feature's gross margin falls below its configured floor.

## Reconciliation and reporting

Run automated checks that verify:

- wallet available plus reserved balances match the ledger;
- every captured reservation has usage events;
- every completed paid job has a settled reservation;
- no provider request ID is billed twice internally;
- no Stripe event grants credits twice;
- expired reservations release their remaining credits;
- provider invoice totals are reasonably close to aggregated usage events;
- plan-level credit liabilities and recognized usage are visible separately;
- margin is reported using net payment revenue, not face-value credits.

Admin reporting should show aggregates and operational metadata without routine access to student document contents.

## Implementation sequence

1. Confirm plan prices, credit grants, expiry treatment, refund policy, and accounting treatment.
2. Build versioned provider-price and feature-rate-card modules.
3. Add wallet, ledger, credit-lot, reservation, usage-event, and payment-event schema with RLS.
4. Implement and concurrency-test reserve, settle, release, expiry, refund, and reversal operations.
5. Add verified Stripe webhook handling and reconciliation.
6. Put one low-risk feature behind the full reservation pipeline.
7. Test duplicate requests, simultaneous tabs, insufficient credits, provider timeout, worker crash, retry, refund, chargeback, and malicious direct Data API calls.
8. Add dashboards, margin alerts, and provider kill switches.
9. Enable Autopilot only after measured feature costs remain within the configured margin floor.

## Launch acceptance criteria

- Two simultaneous requests cannot spend the same credits.
- A browser cannot grant credits, alter prices, select an unapproved model, or mutate a wallet.
- Duplicate job requests and payment webhooks are financially idempotent.
- A worker crash can resume without duplicate provider calls or charges.
- No successful job exceeds its reserved credits or provider-cost ceiling.
- Failed jobs release unused student credits and record Aido's actual loss.
- RLS prevents anonymous and unrelated authenticated users from accessing wallet, ledger, reservation, payment, or usage rows.
- Service-role and provider secrets never reach client bundles or logs.
- Finance can reconcile wallet, ledger, payments, jobs, and provider costs.
