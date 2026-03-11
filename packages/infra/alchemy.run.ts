import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveRuntimeContext } from "@corporation/config/runtime";
import { getStageServerHostname } from "@corporation/config/server-url";
import { deriveEnvTier } from "@corporation/config/stage";
import alchemy from "alchemy";
import {
	DurableObjectNamespace,
	KVNamespace,
	Ruleset,
	Tunnel,
	Vite,
	Worker,
} from "alchemy/cloudflare";
import { CloudflareStateStore } from "alchemy/state";
import { config } from "dotenv";

// In local dev, load from .env files. In CI, env vars are already set.
config({ path: resolve(import.meta.dirname, ".env"), override: false });
config({
	path: resolve(import.meta.dirname, "../../apps/server/.env"),
	override: false,
});
config({
	path: resolve(import.meta.dirname, "../../apps/web/.env"),
	override: false,
});
const stage = process.env.STAGE?.trim();
if (!stage) {
	throw new Error(
		"Missing STAGE for infra runtime. Run `bun secrets:inject` first."
	);
}
const envTier = deriveEnvTier(stage);
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
const serverHostname =
	envTier === "dev" ? getStageServerHostname(stage) : undefined;
const serverTunnel =
	envTier === "dev"
		? await Tunnel("agent-server-tunnel", {
				apiToken: alchemy.secret(process.env.CLOUDFLARE_API_TOKEN),
				name: `agent-server-${stage}`,
				adopt: true,
				ingress: [
					{
						hostname: serverHostname,
						service: "http://localhost:3000",
					},
					{
						service: "http_status:404",
					},
				],
			})
		: undefined;

function getCloudflaredPath(): string {
	const candidates = [
		"/opt/homebrew/bin/cloudflared",
		"/usr/local/bin/cloudflared",
	];

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	throw new Error(
		"Missing cloudflared binary. Install it locally so the dev tunnel can run."
	);
}

if (serverTunnel && app.local) {
	const cloudflaredPath = getCloudflaredPath();
	await app.spawn("agent-server-tunnel", {
		cmd: `${cloudflaredPath} tunnel run --token $TUNNEL_TOKEN`,
		env: {
			TUNNEL_TOKEN: serverTunnel.token.unencrypted,
		},
		processName: "cloudflared",
		quiet: true,
	});
}

if (serverHostname) {
	await Ruleset("agent-server-proxy-bypass", {
		apiToken: alchemy.secret(process.env.CLOUDFLARE_API_TOKEN),
		zone: "corporation.dev",
		phase: "http_request_firewall_custom",
		name: `agent-server-proxy-bypass-${stage}`,
		description:
			"Allow authenticated internal proxy ingress to reach the worker",
		rules: [
			{
				description:
					"Skip Cloudflare browser and firewall heuristics for internal proxy ingress",
				expression: `http.host eq "${serverHostname}" and starts_with(http.request.uri.path, "/api/proxy")`,
				action: "skip",
				action_parameters: {
					products: ["bic", "securityLevel", "uaBlock", "waf"],
				},
			},
		],
	});
}

export const server = await Worker("agent-server", {
	cwd: "../../apps/server",
	entrypoint: "src/index.ts",
	compatibility: "node",
	bindings: {
		ANTHROPIC_API_KEY: alchemy.secret(process.env.ANTHROPIC_API_KEY),
		E2B_API_KEY: alchemy.secret(process.env.E2B_API_KEY),
		NANGO_SECRET_KEY: alchemy.secret(process.env.NANGO_SECRET_KEY),
		CORPORATION_INTERNAL_API_KEY: alchemy.secret(
			process.env.CORPORATION_INTERNAL_API_KEY
		),
		...runtime.serverBindings,
		ACTOR_DO: actorDO,
		ACTOR_KV: actorKV,
	},
	dev: {
		port: 3000,
	},
});

console.log(`Agent server -> ${server.url}`);
if (serverHostname) {
	console.log(`Agent server tunnel -> https://${serverHostname}`);
}

// Resolve custom domain for deployed stages
function getWebDomain(): string | undefined {
	if (envTier === "prod") {
		return "app.corporation.dev";
	}
	if (envTier === "preview") {
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
