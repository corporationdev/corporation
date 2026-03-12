## Quick Reference

- **Format code**: `bun fix`
- **Check for issues**: `bun check`
- **Typecheck**: `bun check-types`

When adding new imports, always add the code that uses the import before or in the same edit as the import statement. Never add an import in isolation — the linter will strip unused imports, causing failures on the next pass.

## Architecture

Bun monorepo with Turborepo. Cloud dev environment product — users connect GitHub repos, provision E2B sandboxes, and interact via chat sessions, terminals, and port previews.

**Data flow:** User action → React UI (`packages/app`) → Convex (`packages/backend`) for persistent data OR Cloudflare Durable Objects in `apps/server` for live session state → E2B sandbox (runs sandbox-agent for AI chat, PTY for terminals, port forwarding for previews).

## Monorepo Layout

```
apps/
  web/              Vite + React frontend, deployed to Cloudflare Pages
  server/           Cloudflare Worker + raw Durable Objects
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

TanStack Router (file-based routing in `src/routes/`), TanStack Query, Zustand stores, shadcn/ui. Auth via Better-Auth client. Connects to the `apps/server` Durable Objects for live session/terminal/preview state.

## Convex Backend — `packages/backend/convex/`

Persistent data: repositories, environments, spaces, snapshots. Schema in `schema.ts`. Use `authedQuery`/`authedMutation` wrappers from `functions.ts` — not raw `query`/`mutation`. Actions in `sandboxActions.ts` and `snapshotActions.ts` provision E2B sandboxes and build snapshots. Webhooks in `http.ts`.

## Cloudflare Server — `apps/server/`

Hono API (`src/app.ts`) + one Durable Object per space. The Durable Object manages live state — sessions, terminals, and previews — via the `src/space-do/` modules. Local Drizzle SQLite stores transient tab metadata.

## Key External Services

- **Convex** — database, real-time queries, auth (Better-Auth integration)
- **E2B** — sandboxed Linux environments for code execution
- **sandbox-agent** — AI agent SDK running inside E2B (chat, tool use, code editing)
- **Nango** — User OAuth token management
- **Alchemy** — Cloudflare infrastructure-as-code (`packages/infra/alchemy.run.ts`)
