# Phase 2 cron and reconciliation staging evidence

> Verified: 2026-07-20
> Environment: isolated AidoForMe staging
> Supabase project: `vokjkogzvtohdinhxhkk`
> Vercel project: `aidofor-me-2afl` (`prj_B0ekOYIrsDQnukuD9HLbEqRcUiqU`)

No secret value or private financial row is recorded in this document.

## Deployed route protection

The production deployment for the staging project was
`dpl_BSfavseTsECCJP5BSzyPU338iJRY` on branch `codex/phase2-staging`.
Ordinary requests without `CRON_SECRET` were sent to both deployed routes:

| Route | Method | Result |
|---|---|---|
| `/api/internal/maintenance` | `GET` | HTTP 401 |
| `/api/internal/reconcile` | `GET` | HTTP 401 |

Vercel runtime logs independently recorded both 401 responses. This proves a
browser request cannot run either financial job.

## Authenticated staging verification

The repeatable secret-safe command is:

```bash
pnpm phase2:verify-cron-staging \
  --env-file /absolute/path/.env.staging.local \
  --output /absolute/private/path/cron-evidence.json
```

The verifier refuses any Supabase target except
`vokjkogzvtohdinhxhkk`, requires `AIDO_BILLING_CONFIG_TARGET=staging`,
requires a Stripe test-mode key, never prints credentials, and writes its
private JSON evidence outside the repository with mode `0600`. Read-only 401
checks have one bounded network retry. Authenticated POST requests are sent
exactly once and are never retried after an ambiguous network result.

The successful run at `2026-07-20T12:02:55.688Z` produced:

- maintenance HTTP 200;
- zero selected or expired reservations and credit lots;
- zero maintenance failures and `has_more: false`;
- reconciliation HTTP 200;
- persisted run `9d55511f-f8cc-4387-912e-c3d415611366` with scope
  `scheduled` and status `completed`;
- six internal checks, zero Stripe objects checked, zero provider invoices
  checked, zero reconciliation issues, and zero issue rows; and
- matching Vercel runtime-log entries for both successful POST requests.

The zero Stripe/invoice counts are expected because no real sandbox Checkout
or provider-invoice lifecycle has been completed. They are not evidence for
those separate exit criteria.

## Remaining scheduled-run evidence

This was a manual authenticated invocation of the real production-deployed
routes. It proves route authorization, server configuration, database access,
maintenance execution, reconciliation persistence, and clean handling of the
current empty financial state.

It does **not** claim that Vercel's scheduler triggered the jobs. The configured
daily schedules are `47 1 * * *` for maintenance and `17 2 * * *` for
reconciliation. The current staging production deployment was created after
the 2026-07-20 schedule windows, so the first eligible automatic windows are
2026-07-21 01:47 UTC and 02:17 UTC. Phase 2 still requires those scheduler-
originated runtime logs and their corresponding database evidence.
