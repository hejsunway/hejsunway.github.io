# Phase 2 Stripe staging evidence

> Verified: 2026-07-20
> Stripe account: `AidoForMe` (`acct_1Tv6yz1tdTVob40G`)
> Mode: sandbox/test only (`livemode: false`)

No secret or webhook signing value is recorded in this document.

## Products and prices

| Purpose | Product | Price | Verified terms |
|---|---|---|---|
| RM20 top-up | `prod_Uuwy6sHjowHeFo` | `price_1Tv74C1tdTVob40GsRVesOzt` | MYR 20.00 one-time; grants 2,000 credits; credits expire after 180 days |
| RM29 monthly | `prod_Uux0WCbJdLWarO` | `price_1Tv76M1tdTVob40GfIIOS4Gd` | MYR 29.00 monthly; grants 2,900 credits for each paid renewal; each grant expires after 35 days |

The product descriptions and product/price metadata record the approved credit
grant, expiry, product key, and staging environment. All four Stripe objects
were read back through the sandbox API and reported `livemode: false`.

On 2026-07-20, a secret-safe verifier compared those four objects with the
reviewed outside-repository configuration (SHA-256
`ee3d88a7d0e2662cb125cb6d3d0dcd6224b7f50b36e32a1194e88fb5e6bded51`).
It found that the amounts, billing modes, grants, expiry periods, and staging
flags were already correct, but all four `aido_product_key` metadata values
used older shortened keys. The verifier updated only those sandbox metadata
fields, read every object back, and passed. A second read-only run passed with
zero pending metadata changes, proving the catalog now matches the reviewed
product keys idempotently.

The apply and read-only verifier reports remain outside the repository with
mode `0600` at:

- `/Users/hoeenjoe/Documents/AidoForMe-private/phase2-stripe-catalog-metadata-apply-evidence-2026-07-20.json`
- `/Users/hoeenjoe/Documents/AidoForMe-private/phase2-stripe-catalog-evidence-2026-07-20.json`

No Checkout Session, charge, subscription, refund, dispute, credit grant, or
other financial lifecycle object was created by this metadata repair.

## Customer portal

Configuration `bpc_1Tv93i1tdTVob40Gc9FMuhaa` is active and named
`AidoForMe Staging cancellation-only`.

Verified feature policy:

- payment-method updates enabled;
- invoice history enabled;
- subscription cancellation enabled at the end of the current billing period;
- cancellation does not create prorations;
- cancellation reasons enabled;
- subscription updates disabled, including plan/price and quantity changes;
- customer profile updates disabled;
- hosted portal login page disabled.

## Webhook destination

Verified on 2026-07-20: the active sandbox webhook destination
`we_1TvATZ1tdTVob40Grp6oRzNM` is named `AidoForMe staging billing webhook` and
delivers to:

`https://aidofor-me-2afl.vercel.app/api/stripe/webhook`

It listens for exactly these events:

- `checkout.session.completed`
- `invoice.paid` and `invoice.payment_failed`
- `customer.subscription.created`, `customer.subscription.updated`, and
  `customer.subscription.deleted`
- `customer.subscription.paused` and `customer.subscription.resumed`
- `refund.created`
- `charge.dispute.created`

Its signing secret is stored only in the developer-owned staging environment
and the isolated Vercel staging project's server environment. The secret value
is intentionally not recorded here.

Deployment `dpl_DXAqB56QpptwmrLnj7RcYdchJXt5` from commit `623b88d` corrected
the failure boundary so a configured endpoint returns HTTP 400 for both a
missing signature and an invalid signature; HTTP 503 is reserved for a missing
server-side webhook secret. The secret-safe verifier observed both HTTP 400
responses at the stable staging URL. Vercel runtime logs independently recorded
the two POST requests against that exact deployment. These are rejection-path
checks only, not proof of a valid signed event.

## Still missing

No valid signed financial delivery has been received yet. Test purchases,
renewal, failed renewal, cancellation, refund, dispute, duplicate delivery,
and financial reconciliation have not yet been executed. Those real sandbox
events must prove signature verification, idempotency, credit effects, and
reconciliation before the Phase 2 exit gate can pass.
