---
name: insforge
description: Operate an InsForge backend (open-source, agent-native backend platform) from a project. Use when provisioning or managing Postgres databases, schema and migrations, row-level security and policies, authentication, S3-compatible file storage, Deno edge functions, the OpenAI-compatible model gateway, or cloud deployment. Also use when wiring the InsForge MCP server or CLI into an agent, generating typed SDK clients, or debugging backend/auth/storage failures.
---

# InsForge

InsForge is an open-source, agent-native backend platform: Postgres database,
auth, S3-compatible storage, Deno edge functions, an OpenAI-compatible model
gateway, and site deployment — all drivable from a project through an MCP
server or the CLI plus skills.

License: Apache-2.0. Upstream: `https://github.com/InsForge/InsForge`.

## When to use this skill

- Provision or connect an InsForge backend to a project.
- Design or change the database schema, write migrations, or add row-level
  security (RLS) policies and grants.
- Add authentication (email/password, OAuth providers, sessions, roles).
- Store or serve files through S3-compatible object storage and buckets.
- Write, deploy, or debug Deno edge functions.
- Route model calls through the OpenAI-compatible model gateway.
- Deploy the backend or a static site to InsForge Cloud.
- Wire the InsForge MCP server into an agent so it can call these operations.

## Two integration paths

1. **MCP server** — the agent gets first-class tools for database, auth,
   storage, functions, and deployment. Preferred for interactive work.
2. **CLI + Skills** — a terminal workflow (`insforge ...`) for scripting,
   CI, and reproducible setup. Preferred for automation.

Both paths hit the same control plane and the same project credentials.

## Connecting the MCP server

Install the project-scoped MCP server for the agent client and pass the
project credentials as environment variables:

```bash
npx @insforge/install --client claude-code \
  --env API_KEY=<project-api-key> \
  --env API_BASE_URL=<https://your-project.insforge.app>
```

Notes:

- The API key and base URL are **secrets**. Keep them in environment variables
  or the client's secret store — never commit them, never paste them into a
  prompt, and never echo them into logs.
- Scope the key to the narrowest project and role that the task needs.
- Re-run the installer with a different `--client` value to target another
  agent runtime.

## Working rules

- **Never invent the API.** Check the live schema/tool list before calling a
  capability; the control plane is the source of truth.
- **Migrations are ordered and additive.** Add columns as nullable or with a
  default before backfilling, then tighten constraints in a later migration.
  Never drop a column in the same step that stops writing it.
- **RLS is not optional.** Every table that stores user data must have RLS
  enabled with explicit policies. Default to deny; grant per operation and
  per role. Verify with a non-privileged request before shipping.
- **Secrets live server-side.** Edge functions read secrets from the runtime's
  secret store — never hardcode keys in function source or client bundles.
- **Bound every input.** Validate types and lengths at the edge function
  boundary, cap pagination, and rate-limit anything that writes or sends mail.
- **Least privilege for service keys.** A service-role key bypasses RLS; use it
  only inside trusted server code, never in a browser or mobile client.

## Typical flow

1. Confirm the project and credentials (API key scoped to the right project).
2. Inspect the existing schema and policies before proposing changes.
3. Write a migration for the schema change; enable RLS and add policies.
4. Generate or update the typed client so the app and the schema stay aligned.
5. Add or update the edge function, with input validation and secret lookups
   from the runtime store.
6. Deploy, then verify with a request that exercises the real auth path.

## Verification checklist

- Schema matches the intended migration; no drift between client types and
  the live database.
- RLS enabled on every user-data table, with a deny-by-default policy.
- Auth flow works end to end for the intended providers and roles.
- Storage buckets are scoped; object keys cannot be guessed into other
  tenants' data.
- Edge functions validate input, read secrets from the store, and return
  bounded responses.
- No secret, key, or connection string appears in source, logs, or the repo.
