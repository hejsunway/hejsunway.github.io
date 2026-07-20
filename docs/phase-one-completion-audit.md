# Phase 1 completion audit

> Date: 2026-07-20  
> Authority: `docs/implementation-plan.md`  
> Status: **Phase 1 implementation gate closed on isolated staging**

## Decision

Phase 2 implementation may proceed. The Phase 1 code, additive completion
migration, and privilege-hardening migration pass both the local exit gate and
the isolated staging gate. The linked shared TutorPakar Supabase production project
does not record the original Phase 1 project, completion, or privilege-hardening
migrations in `supabase_migrations.schema_migrations`. Metadata inspection shows
that the original Phase 1 tables were applied manually, while the completion
columns and tables are not live. It also exposed broad legacy grants including
`TRUNCATE`, `TRIGGER`, and `REFERENCES` to `authenticated`; this is fixed in the
reviewed migration but remains unchanged in production.

The application remains backward-compatible with that linked state. Replacement
controls are shown only after `aido_project_policies` is available, project reads
work before and after the completion columns exist, and deletion temporarily
falls back to the original owner-scoped path when the new audited RPC is absent.

Do not enable chargeable Phase 2 provider work or apply these migrations directly
to the shared production database. Phase 2 must now satisfy its own staging exit
gate before any production promotion.

## Phase 1 evidence

| Exit requirement | Evidence | Result |
|---|---|---|
| Real project and file survive sign-out/sign-in | `scripts/test-phase-one-integration.mjs` creates an isolated user, uploads a real text file through Storage, registers it, signs out/in, and reloads the persisted project and metadata | Pass locally |
| Unrelated user cannot read, list, change, download, or delete owner data | `supabase/tests/database/phase_one_rls.test.sql` plus the API integration test cover project rows, Storage listing/download, updates, audit rows, and anonymous grants | Pass locally |
| Failed upload does not create completed metadata | Integration test uploads an object then attempts registration with mismatched stored size; the database rejects it and only the valid document remains | Pass locally |
| Project deletion covers Storage, relational rows, and durable audit | Integration test removes all project objects through the Storage API, calls `aido_delete_project`, verifies project/document cascades, verifies no objects remain, and verifies one persistent deletion-audit row | Pass locally |
| Genuine empty state | `/app` renders the empty state only when the authenticated project query returns no rows; `scripts/check-no-demo-data.mjs` blocks known sample/mock patterns | Pass in code |
| Policy snapshot and confirmation activity | Completion migration adds `aido_project_policies`; pgTAP verifies exact text persistence and one `project.policy_confirmed` event | Pass locally |
| File count, type, magic-byte, and decompression controls | Database limits active documents to 12; server validation enforces 25 MiB, allowed extensions/MIME, magic bytes, UTF-8 text, and DOCX entry/expanded-size/compression-ratio ceilings | Pass in migration/code |
| Replacement and retry behavior | Immutable-path replacement RPC locks the current row, adds a replacement row, preserves the superseded metadata, and records one activity event | Pass locally |
| Least-privilege Data API surface | `20260719142000_aido_phase_one_privilege_hardening.sql` removes broad defaults and re-grants the exact table, sequence, and RPC surface; pgTAP checks both required and forbidden privileges | Pass locally |
| Database/security CI gate | CI starts an isolated Supabase stack, runs 41 Phase 1 pgTAP assertions, runs the API/Storage integration, and fails on database-advisor warnings | Configured |

## Local verification commands

```bash
pnpm supabase start -x edge-runtime,imgproxy,realtime,studio,vector
pnpm supabase db reset --local --no-seed
pnpm test:db

# Export only local credentials printed by `supabase status -o env`, then:
pnpm test:phase1

pnpm db:advisors
pnpm check:no-demo
pnpm lint
pnpm typecheck
pnpm build
```

Observed results on 2026-07-20 after privilege hardening:

- all four Phase 1 migrations applied cleanly to PostgreSQL 17 locally;
- 41/41 Phase 1 pgTAP assertions passed (156/156 across the current database suite);
- Phase 1 API/Storage integration passed;
- Supabase database advisors returned no issues;
- no-demo, ESLint, TypeScript, and production build passed.

## Linked-project release gate

The linked database is shared with TutorPakar and must not be used for migration
experimentation. Before applying anything:

1. Create or select a non-production staging Supabase project with the same Aido
   migrations and relevant Auth/Storage configuration.
2. Run the full local commands above against staging with developer-owned test
   accounts and files.
3. Review `20260719141159_aido_phase_one_completion.sql` and
   `20260719142000_aido_phase_one_privilege_hardening.sql`, then take a database
   backup/restore point.
4. Because `20260719123037_aido_phase_one_projects.sql` appears to have been
   applied manually, reconcile its migration-history entry only after confirming
   its live schema matches the file. Do not blindly re-run the table-creation
   migration.
5. Apply only the additive completion and privilege-hardening migrations, run
   linked security/performance advisors, run
   `scripts/audit-phase-one-schema.sql`, and repeat the two-user
   persistence/Storage test in staging.
6. Promote to the shared production project only after the staging exit gate is
   signed off.

## Staging sign-off

The dedicated `AidoForMe Staging` Supabase project
(`vokjkogzvtohdinhxhkk`, Singapore) was created on 2026-07-20 at the confirmed
cost of $0/month. The four canonical Phase 1 migrations were applied individually:

- `aido_product_memberships`
- `aido_phase_one_projects`
- `aido_phase_one_completion`
- `aido_phase_one_privilege_hardening`

Evidence:

- all 13 read-only schema, RLS, grant, RPC, sequence, bucket, Storage-policy,
  and migration-history checks passed;
- Supabase security advisors returned no findings;
- performance advisors returned only expected unused-index informational notices
  on the new empty database, with no warning or error;
- the guarded hosted integration created two temporary confirmed Auth users,
  inserted owner-scoped memberships, uploaded a real assignment file, registered
  and completed the project, survived sign-out/sign-in, rejected mismatched
  metadata, proved unrelated-user isolation, deleted Storage and relational state,
  and retained the deletion audit until user cleanup;
- post-test cleanup proved zero temporary Auth users, memberships, projects,
  project members, documents, activity, policies, deletion-audit rows, and
  Storage objects.

Production was not modified. Phase 1 is therefore complete for implementation
sequencing, and Phase 2 may proceed in local and staging environments.

The exact linked-production findings are recorded in
[`phase-one-linked-drift-audit.md`](./phase-one-linked-drift-audit.md). Production
was inspected through metadata-only reads and was not mutated.

## Relevant Supabase guidance

- [Testing your database](https://supabase.com/docs/guides/database/testing)
- [Testing and linting with the CLI](https://supabase.com/docs/guides/local-development/cli/testing-and-linting)
- [Storage access control](https://supabase.com/docs/guides/storage/security/access-control)
- [Securing your API](https://supabase.com/docs/guides/api/securing-your-api)
- [Explicit Data API grants change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)
