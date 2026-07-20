# Phase 1 staging release runbook

> Scope: prove the Phase 1 exit gate on a non-production Supabase project before any Phase 2 release work.

> Completed: 2026-07-20 on staging project `vokjkogzvtohdinhxhkk`.

## Hard boundaries

- The shared TutorPakar project ref `gmqlmqdqpytgjxolgrwq` is production and is not an allowed staging target.
- Do not experiment with migration-history repair on that project.
- Do not commit or print a database password, service-role key, Stripe key, or provider key.
- The current migration directory also contains Phase 2 migrations. Do not run an unreviewed `supabase db push` against staging while proving the Phase 1-only gate.

## 1. Provision or select staging

The project owner must choose the Supabase organization and approve any recurring project or branch cost. Use a dedicated non-production project with developer-owned test users and files. A Supabase branch is also acceptable if its cost and lifecycle are explicitly approved.

Record its 20-letter project ref as `AIDO_STAGING_PROJECT_REF`. It must not equal the production ref above.

## 2. Apply Phase 1 only

Review and apply these migrations to staging in order through the approved migration pipeline:

1. `20260719000000_aido_product_memberships.sql`
2. `20260719123037_aido_phase_one_projects.sql`
3. `20260719141159_aido_phase_one_completion.sql`
4. `20260719142000_aido_phase_one_privilege_hardening.sql`

Do not apply the Phase 2 migrations until the checks below pass. After application, verify that all four canonical migration names appear in `supabase_migrations.schema_migrations` (managed API application may assign new server timestamps), run `scripts/audit-phase-one-schema.sql` and require every row to pass, inspect RLS and explicit grants, and run both Supabase security and performance advisors.

## 3. Run the guarded integration check

Provide credentials through the shell's secret manager or CI secret store:

```text
API_URL=https://<staging-ref>.supabase.co
ANON_KEY=<staging publishable or legacy anon key>
SERVICE_ROLE_KEY=<staging service-role key>
AIDO_STAGING_PROJECT_REF=<staging-ref>
AIDO_ALLOW_STAGING_WRITE_TEST=1
```

Then run:

```bash
pnpm test:phase1:staging
```

The script refuses localhost, refuses the production ref, and refuses an API URL that does not match the declared staging ref. It creates temporary developer-owned users, a real Storage object, project rows, policy state, and activity; proves persistence and unrelated-user isolation; then removes the temporary project, objects, and users.

## 4. Sign off the gate

Phase 1 is ready to open Phase 2 staging work only when all of these have evidence:

- four canonical Phase 1 migration names recorded in staging history;
- every `scripts/audit-phase-one-schema.sql` check passes;
- staging security and performance advisors have no unresolved warning;
- `pnpm test:phase1:staging` passes;
- the staging bucket is private and contains no leftover test object;
- both temporary Auth users and all temporary Aido rows are removed;
- no production schema, migration history, customer row, or Storage object changed.

Attach the project ref, migration list, advisor results, integration-test output, and cleanup confirmation to `docs/phase-one-completion-audit.md`. Do not paste secrets.
