# corporation

## Env Setup

Inject environment files from 1Password:

```bash
bun secrets:inject
```

Stage-aware variants:

```bash
bun secrets:inject            # auto mode (sandbox env -> sandbox stage, else dev stage)
bun secrets:inject --dev      # force dev stage: dev-<user>-<hash>
bun secrets:inject --sandbox  # force sandbox stage: sandbox-<user>-<id/hash>
```

This command reads `.env.op`, discovers all `.env.example` files, and writes service `.env` files.

Adding a new secret:

1. Add it in `.env.op`.
2. Add the key in the target service `.env.example`.
3. Re-run `bun secrets:inject`.

This project was created with [Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack), a modern TypeScript stack that combines React, TanStack Router, Convex, and more.

## Features

- **TypeScript** - For type safety and improved developer experience
- **TanStack Router** - File-based routing with full type safety
- **TailwindCSS** - Utility-first CSS for rapid UI development
- **shadcn/ui** - Reusable UI components
- **Convex** - Reactive backend-as-a-service platform
- **Authentication** - Better-Auth
- **Biome** - Linting and formatting
- **Turborepo** - Optimized monorepo build system

## Getting Started

First, install the dependencies:

```bash
bun install
```

## Convex Setup

This project uses Convex as a backend. You'll need to set up Convex before running the app:

```bash
bun run dev:setup
```

Follow the prompts to create a new Convex project and connect it to your application.

Copy environment variables from `packages/backend/.env.local` to `apps/*/.env`.

Then, run the development server:

```bash
bun run dev
```

Open [http://localhost:3001](http://localhost:3001) in your browser to see the web application.
Your app will connect to the Convex cloud backend automatically.

## Git Hooks and Formatting

- Format and lint fix: `bun run check`

## Project Structure

```
corporation/
├── apps/
│   ├── web/         # Frontend application (React + TanStack Router)
├── packages/
│   ├── backend/     # Convex backend functions and schema
```

## Available Scripts

- `bun run dev`: Start all applications in development mode
- `bun run build`: Build all applications
- `bun run test`: Run package test suites through Turborepo
- `bun run test:sandbox-runtime`: Run sandbox-runtime tests locally
- `bun run test:sandbox-runtime:local`: Run sandbox-runtime tests locally
- `bun run test:sandbox-runtime:sandbox`: Run sandbox-runtime tests in a real E2B sandbox
- `bun run dev:web`: Start only the web application
- `bun run dev:setup`: Setup and configure your Convex project
- `bun run check-types`: Check TypeScript types across all apps
- `bun run check`: Run Biome formatting and linting

## Sandbox Runtime Tests

The `apps/sandbox-runtime` package supports two test targets:

- Local: `bun run test:sandbox-runtime` or `bun run test:sandbox-runtime:local`
- Real sandbox: `bun run test:sandbox-runtime:sandbox`

Turbo does not manage Python tool installation for us, so local proxy tests fail fast if `mitmdump` is not already on your `PATH`. Install it once on your machine with one of:

```bash
uv tool install mitmproxy
pipx install mitmproxy
```

Sandbox proxy tests require `E2B_API_KEY` and a sandbox template with `mitmproxy` installed, such as the template built by:

```bash
bun run rebuild:template
```
