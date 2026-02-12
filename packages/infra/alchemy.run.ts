import alchemy from "alchemy";
import {
	DurableObjectNamespace,
	KVNamespace,
	Worker,
} from "alchemy/cloudflare";
import { config } from "dotenv";

config({ path: "../../apps/server/.env" });

const app = await alchemy("corporation");

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
		DAYTONA_API_KEY: alchemy.secret(process.env.DAYTONA_API_KEY),
		ANTHROPIC_API_KEY: alchemy.secret(process.env.ANTHROPIC_API_KEY),
		NANGO_SECRET_KEY: alchemy.secret(process.env.NANGO_SECRET_KEY),
		CONVEX_SITE_URL: alchemy.env("CONVEX_SITE_URL"),
		CONVEX_URL: alchemy.env("CONVEX_URL"),
		ACTOR_DO: actorDO,
		ACTOR_KV: actorKV,
	},
	dev: {
		port: 3000,
	},
});

console.log(`Agent server -> ${server.url}`);

await app.finalize();
