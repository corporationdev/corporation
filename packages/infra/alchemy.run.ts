import { resolveRuntimeContext } from "@corporation/config/runtime";
import { getStageKind } from "@corporation/config/stage";
import alchemy from "alchemy";
import {
	DurableObjectNamespace,
	KVNamespace,
	Vite,
	Worker,
} from "alchemy/cloudflare";
import { CloudflareStateStore } from "alchemy/state";
import { config } from "dotenv";

// In local dev, load from .env files. In CI, env vars are already set.
config({ path: "../../apps/server/.env", override: false });
config({ path: "../../apps/web/.env", override: false });
const stage = process.env.STAGE?.trim();
if (!stage) {
	throw new Error(
		"Missing STAGE for infra runtime. Run `bun secrets:inject` first."
	);
}
const stageKind = getStageKind(stage);
const allowMissingPreviewConvex =
	process.env.ALLOW_MISSING_PREVIEW_CONVEX === "1";
const runtime = resolveRuntimeContext(stage, {
	allowMissingPreviewConvex,
});

const app = await alchemy("corporation", {
	stage,
	stateStore: process.env.CI
		? (scope) => new CloudflareStateStore(scope)
		: undefined,
});

const actorDO = DurableObjectNamespace("actor-do", {
	className: "ActorHandler",
	sqlite: true,
});

const actorKV = await KVNamespace("actor-kv");

export const server = await Worker("agent-server", {
	cwd: "../../apps/server",
	entrypoint: "src/index.ts",
	compatibility: "node",
	bindings: {
		E2B_API_KEY: alchemy.secret(process.env.E2B_API_KEY),
		ANTHROPIC_API_KEY: alchemy.secret(process.env.ANTHROPIC_API_KEY),
		NANGO_SECRET_KEY: alchemy.secret(process.env.NANGO_SECRET_KEY),
		INTERNAL_API_KEY: alchemy.secret(process.env.INTERNAL_API_KEY),
		...runtime.serverBindings,
		ACTOR_DO: actorDO,
		ACTOR_KV: actorKV,
	},
	dev: {
		port: 3000,
	},
});

console.log(`Agent server -> ${server.url}`);

// Resolve custom domain for deployed stages
function getWebDomain(): string | undefined {
	if (stageKind === "production") {
		return "app.corporation.dev";
	}
	if (stageKind === "preview") {
		return `${stage}.corporation.dev`;
	}
	return undefined;
}

const webDomain = getWebDomain();

export const web = await Vite("web", {
	cwd: "../../apps/web",
	entrypoint: "worker/index.ts",
	build: "bunx --bun vite build",
	assets: {
		directory: "dist",
		run_worker_first: ["/api/*"],
	},
	domains: webDomain ? [webDomain] : undefined,
	bindings: {
		...runtime.webClientEnv,
		API: server,
	},
});

console.log(`Web    -> ${web.url}`);

await app.finalize();
