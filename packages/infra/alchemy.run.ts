import alchemy from "alchemy";
import { DurableObjectNamespace, Worker } from "alchemy/cloudflare";

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
		SandboxAgent: sandboxAgent,
	},
	dev: {
		port: 3000,
	},
});

console.log(`Agent server -> ${server.url}`);

await app.finalize();
