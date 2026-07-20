# AidoFor.me

AidoFor.me is an AI-assisted academic writing and research workspace for university and college students. It turns an assignment brief and rubric into a source-backed writing plan, then keeps requirements, evidence, citations, and student approvals connected through export.

The product is intentionally assignment-first and evidence-first. It is not a one-click essay generator, an AI detector, or an automatic submission tool.

> **AidoFor.me is a TutorPakar product.** The same email and password works on `tutorpakar.com` and `aidofor.me`, but each product keeps its own data, roles, and sessions.

## Current foundation

- Production Next.js App Router foundation with TypeScript and strict checking
- Public landing page at `/`
- Detailed product workflow at `/how-it-works`
- Academic-integrity and AI-policy guidance at `/academic-integrity`
- Assignment analysis feature page at `/features/brief-to-outline`
- Evidence and citation verification page at `/features/evidence-and-citations`
- Real Supabase auth surfaces at `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/auth/callback`
- Protected `/app` workspace with real project and archive states
- Real assignment setup at `/app/new`, including private verified uploads
- Project detail pages with file download, status, policy, and activity history
- Shared Supabase project with TutorPakar — one identity, two products
- Aido-only memberships, projects, project owners, documents, and activity tables with row-level security
- Private `aido-assignment-files` bucket with owner/project path policies and a 25 MB limit
- Retry-safe project/document RPCs and server-side file signature, size, MIME, and SHA-256 checks
- CI checks for lint, types, production build, and prohibited demo-data patterns
- Official supplied AidoFor.me logo assets in `public/brand`
- Authoritative product requirements in `docs/aidofor-me-prd.md`
- Shared-auth setup notes in `docs/shared-auth-setup.md`

## Local development

This project uses pnpm.

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm check:no-demo
```

## Environment

Copy `.env.example` to `.env.local` and fill in the Supabase URL and
publishable (or legacy anon) key from the **shared TutorPakar** project.

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Same value TutorPakar uses. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Preferred (new `sb_publishable_…` key). |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Legacy JWT anon key. Read as fallback when the publishable key is unset. |
| `NEXT_PUBLIC_SITE_URL` | `https://aidofor.me` in production, `http://localhost:3000` locally. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only billing/provider worker access for the selected environment. |
| `OPENAI_API_KEY` | Server-only; required only when an approved route uses OpenAI. |
| `DEEPSEEK_API_KEY` | Server-only; required only when an approved route uses DeepSeek. |
| `MINIMAX_API_KEY` | Server-only; required only when an approved route uses MiniMax. |
| `STRIPE_SECRET_KEY` | Server-only Stripe sandbox key in staging; live key only after production approval. |
| `STRIPE_WEBHOOK_SECRET` | Secret for the environment-specific `/api/stripe/webhook` endpoint. |
| `STRIPE_PORTAL_CONFIGURATION_ID` | Reviewed portal configuration with plan/quantity changes disabled. |
| `CRON_SECRET` | Server-only bearer secret used by the reconciliation schedule. |

**Never** prefix a Supabase secret or service-role key with
`NEXT_PUBLIC_`. Browser bundles will ship those values to every visitor.
Never add a service-role key to `.env.example` or any committed file.

## Deployment

The application is intended for Vercel. The canonical production domain is
`aidofor.me`, with `www.aidofor.me` redirecting to the apex domain after
the Vercel project and DNS are connected. Do not deploy through GitHub
Pages.

Before promoting to production, complete the manual Supabase Dashboard
checklist in `docs/shared-auth-setup.md`.

## Database migrations

The AidoForMe migrations in `supabase/migrations` add product membership,
project, document, activity, RLS, RPC, and private Storage infrastructure.
They apply cleanly to the isolated local Supabase stack and pass `supabase
db lint --local`.

They are deliberately **not** pushed to the shared production project by
CI. Review the linked-project diff and the checklist in
`docs/shared-auth-setup.md` before running `supabase db push --linked`.

Phase 2 local implementation and remaining release blockers are recorded in
`docs/phase-two-progress-audit.md`. Do not apply the Phase 2 migrations to the
linked shared project without the staging and approval steps in that audit.
Real billing configuration is validated with `pnpm billing:config
/absolute/path/reviewed-config.json`; nothing is applied unless `--apply` and an
exact `AIDO_BILLING_CONFIG_TARGET` are supplied.
