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

## Still missing

The sandbox currently has no webhook endpoint. A real staging deployment URL
and a server-side `STRIPE_WEBHOOK_SECRET` are required before Checkout and
subscription lifecycle evidence can be produced. Test purchases, renewal,
failed renewal, cancellation, refund, dispute, duplicate delivery, and
reconciliation have not yet been executed.
