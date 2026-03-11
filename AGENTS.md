## Quick Reference

- **Format code**: `bun fix`
- **Check for issues**: `bun check`
- **Typecheck**: `bun check-types`

When adding new imports, always add the code that uses the import before or in the same edit as the import statement. Never add an import in isolation — the linter will strip unused imports, causing failures on the next pass.

## Architecture

Bun monorepo with Turborepo. Cloud dev environment product — users connect GitHub repos, provision E2B sandboxes, and interact via chat sessions, terminals, and port previews.

**Data flow:** User action → React UI (`packages/app`) → Convex (`packages/backend`) for persistent data OR RivetKit actor (`apps/server`) for live session state → E2B sandbox (runs sandbox-agent for AI chat, PTY for terminals, port forwarding for previews).

## Monorepo Layout

```
apps/
  web/              Vite + React frontend, deployed to Cloudflare Pages
  server/           Cloudflare Worker + Durable Objects (RivetKit actors)
  desktop/          Electron app (currently unused) 

packages/
  app/              Shared React components, hooks, routes, and stores
  backend/          Convex backend (schema, queries, mutations, actions)
  infra/            Cloudflare infrastructure-as-code (Alchemy)
  config/           Shared tsconfig, runtime stage config
  env/              Typed environment variables (web + server)
  logger/           Pino logger
```

## Frontend — `packages/app/`

TanStack Router (file-based routing in `src/routes/`), TanStack Query, Zustand stores, shadcn/ui. Auth via Better-Auth client. Connects to RivetKit actors for live session/terminal/preview state.

## Convex Backend — `packages/backend/convex/`

Persistent data: repositories, environments, spaces, snapshots. Schema in `schema.ts`. Use `authedQuery`/`authedMutation` wrappers from `functions.ts` — not raw `query`/`mutation`. Actions in `sandboxActions.ts` and `snapshotActions.ts` provision E2B sandboxes and build snapshots. Webhooks in `http.ts`.

## Cloudflare Server — `apps/server/`

Hono API (`src/app.ts`) + one RivetKit Durable Object actor per space (`src/space.ts`). The actor manages live state — sessions, terminals, and previews — via drivers in `src/space/`. Local Drizzle SQLite for transient tab metadata (`src/db/`).

## Key External Services

- **Convex** — database, real-time queries, auth (Better-Auth integration)
- **E2B** — sandboxed Linux environments for code execution
- **sandbox-agent** — AI agent SDK running inside E2B (chat, tool use, code editing)
- **RivetKit** — actor framework on Cloudflare Durable Objects
- **Nango** — User OAuth token management
- **Alchemy** — Cloudflare infrastructure-as-code (`packages/infra/alchemy.run.ts`)

## Cursor Cloud specific instructions

### Environment & Secrets

The normal secret injection flow (`bun secrets:inject`) requires the 1Password CLI (`op`), which is not available in Cloud Agent VMs. Instead, `.env` files are pre-created with placeholder values under `STAGE=sandbox`. Real secrets must be provided via the Cursor Secrets panel (see required secrets below).

### Running Services Individually

- **Convex backend (local/sandbox):** `cd packages/backend && CONVEX_DEPLOY_KEY='<ignore_deploy_key>' CONVEX_AGENT_MODE=anonymous STAGE=sandbox npx convex dev --local` — runs a local SQLite-backed Convex on port 3210 (no cloud credentials needed).
- **Vite frontend:** `cd apps/web && STAGE=sandbox bunx vite --host 0.0.0.0 --port 3001` — starts the web dev server on port 3001.
- **Full dev stack** (`bun dev` / `bun dev:agent`): requires valid `CLOUDFLARE_API_TOKEN`, `ALCHEMY_PASSWORD`, and `cloudflared` binary. The infra package (`packages/infra`) orchestrates the Cloudflare Worker (port 3000) and Vite (port 3001) together with a Cloudflare Tunnel.

### Gotchas

- The Cloudflare Worker server (`apps/server`) has no standalone wrangler config — it is dynamically created by the Alchemy infra at `packages/infra/alchemy.run.ts`. You cannot start it with `wrangler dev` directly.
- Auth (signup/login) requires the server worker on port 3000 because Better-Auth API calls are proxied from the Vite frontend (`/convex/api/auth` → Convex site, general `/api` → localhost:3000).
- `bun check` runs Biome via `ultracite`. There are a few pre-existing formatting issues in the codebase.
- Tests: `bun test` runs tests in `apps/server` and `apps/sandbox-runtime`. Integration tests that talk to E2B will fail without a valid `E2B_API_KEY`.
- The `STAGE` env var controls environment tier. Use `sandbox` for fully local dev (local Convex), or `dev-<user>-<hash>` for cloud Convex with dev tunnel.
