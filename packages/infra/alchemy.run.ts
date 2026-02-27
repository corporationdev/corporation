import { resolveRuntimeContext } from "@corporation/config/runtime";
import alchemy from "alchemy";
import {
	DurableObjectNamespace,
	KVNamespace,
	Vite,
	Worker,
} from "alchemy/cloudflare";
import { config } from "dotenv";

config({ path: "../../apps/server/.env" });
config({ path: "../../apps/web/.env" });
const stage = process.env.STAGE?.trim();
if (!stage) {
	throw new Error(
		"Missing STAGE for infra runtime. Run `bun secrets:inject` first."
	);
}
const runtime = resolveRuntimeContext(stage);

const app = await alchemy("corporation", { stage });

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
		...runtime.serverBindings,
		ACTOR_DO: actorDO,
		ACTOR_KV: actorKV,
	},
	dev: {
		port: 3000,
	},
});

console.log(`Agent server -> ${server.url}`);

export const web = await Vite("web", {
	cwd: "../../apps/web",
	assets: "dist",
	bindings: {
		...runtime.webClientEnv,
	},
});

console.log(`Web    -> ${web.url}`);

await app.finalize();
