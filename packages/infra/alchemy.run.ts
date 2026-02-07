import alchemy from "alchemy";
import { DurableObjectNamespace, Worker } from "alchemy/cloudflare";
import { config } from "dotenv";

config({ path: "../../apps/server/.env" });

const app = await alchemy("corporation");

const sandboxAgent = DurableObjectNamespace("sandbox-agent", {
	className: "SandboxAgent",
	sqlite: true,
});

export const server = await Worker("agent-server", {
	cwd: "../../apps/server",
	entrypoint: "src/index.ts",
	compatibility: "node",
	bindings: {
		DAYTONA_API_KEY: alchemy.secret(process.env.DAYTONA_API_KEY),
		ANTHROPIC_API_KEY: alchemy.secret(process.env.ANTHROPIC_API_KEY),
		SandboxAgent: sandboxAgent,
	},
	dev: {
		port: 3000,
	},
});

console.log(`Agent server -> ${server.url}`);

await app.finalize();
