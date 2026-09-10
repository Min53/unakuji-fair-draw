# PostgreSQL example

```bash
docker compose -f examples/postgres/docker-compose.yml up -d
DATABASE_URL=postgresql://postgres:devpass@localhost:55432/unakuji ./examples/postgres/apply-schema.sh
DATABASE_URL=postgresql://postgres:devpass@localhost:55432/unakuji npx tsx examples/postgres/run.ts
```

This starts a disposable local Postgres 16, applies `db/001_tables.sql` through
`db/004_admin_functions.sql`, and runs `run.ts`, which creates a box, opens
it, issues an entitlement, draws a ticket, and runs a consistency check.

`db/005_roles.sql` (a least-privilege `unakuji_app` role) is optional and not
applied by `apply-schema.sh` — see that file's header.

To point at your own Postgres instead of the docker-compose one, just set
`DATABASE_URL` to it and run `apply-schema.sh` once against it.

The same database also backs `tests/postgres/*.test.ts` — see the repo
README's "Running the tests" section.
