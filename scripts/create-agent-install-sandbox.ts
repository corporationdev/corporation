import { resolve } from "node:path";
import acpAgents from "@corporation/config/acp-agent-manifest";
import { config } from "dotenv";
import { Sandbox } from "e2b";

const repoRoot = resolve(import.meta.dir, "..");

config({
	path: resolve(repoRoot, "apps/server/.env"),
	override: false,
	quiet: true,
});
config({
	path: resolve(repoRoot, "apps/web/.env"),
	override: false,
	quiet: true,
});

const apiKey = process.env.E2B_API_KEY;
const template = process.env.E2B_BASE_TEMPLATE_ID || "corporation-base";
const installConcurrency = Math.max(
	1,
	Number.parseInt(process.env.AGENT_INSTALL_CONCURRENCY || "4", 10) || 4
);

if (!apiKey) {
	throw new Error("Missing E2B_API_KEY");
}

function joinCommands(commands: Array<string | null | undefined>) {
	return commands.filter(Boolean).join("\n");
}

async function runInstallStep(
	sandbox: Sandbox,
	agentId: string,
	label: "native" | "acp",
	command: string
) {
	const result = await sandbox.commands.run(
		joinCommands([`export PATH="$HOME/.local/bin:$PATH"`, command]),
		{
			timeoutMs: 5 * 60_000,
		}
	);

	if (result.exitCode !== 0) {
		throw new Error(
			[
				`${agentId} ${label} install failed`,
				result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : null,
				result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : null,
			]
				.filter(Boolean)
				.join("\n\n")
		);
	}
}

async function ensureUserPath(sandbox: Sandbox) {
	await sandbox.commands.run(
		joinCommands([
			`grep -qxF 'export PATH="$HOME/.local/bin:$PATH"' "$HOME/.bashrc" || printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.bashrc"`,
			`grep -qxF 'export PATH="$HOME/.local/bin:$PATH"' "$HOME/.profile" || printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.profile"`,
		]),
		{ timeoutMs: 10_000 }
	);
}

async function installAgent(input: {
	sandbox: Sandbox;
	agent: (typeof acpAgents)[number];
}): Promise<void> {
	if (input.agent.nativeInstallCommand) {
		await runInstallStep(
			input.sandbox,
			input.agent.id,
			"native",
			input.agent.nativeInstallCommand
		);
	}

	if (input.agent.acpInstallCommand) {
		await runInstallStep(
			input.sandbox,
			input.agent.id,
			"acp",
			input.agent.acpInstallCommand
		);
	}
}

function createAgentWorker(input: {
	sandbox: Sandbox;
	installableAgents: (typeof acpAgents)[number][];
	nextAgent: () => (typeof acpAgents)[number] | undefined;
	installed: string[];
	failed: Array<{ agentId: string; error: string }>;
}): Promise<void> {
	return (async () => {
		while (true) {
			const agent = input.nextAgent();
			if (!agent) {
				return;
			}

			try {
				await installAgent({
					sandbox: input.sandbox,
					agent,
				});
				input.installed.push(agent.id);
				console.log(`installed ${agent.id}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				input.failed.push({ agentId: agent.id, error: message });
				console.error(`failed ${agent.id}\n${message}\n`);
			}
		}
	})();
}

async function main() {
	const sandbox = await Sandbox.betaCreate(template, {
		apiKey,
		timeoutMs: 15 * 60_000,
		network: { allowPublicTraffic: true },
		lifecycle: { onTimeout: "pause" },
	});

	const installableAgents = acpAgents.filter(
		(agent) => agent.nativeInstallCommand || agent.acpInstallCommand
	);
	const installed: string[] = [];
	const failed: Array<{ agentId: string; error: string }> = [];

	try {
		await ensureUserPath(sandbox);

		let nextIndex = 0;
		const nextAgent = () => installableAgents[nextIndex++];
		const workers = Array.from(
			{ length: Math.min(installConcurrency, installableAgents.length) },
			() =>
				createAgentWorker({
					sandbox,
					installableAgents,
					nextAgent,
					installed,
					failed,
				})
		);

		await Promise.all(workers);
	} finally {
		console.log(
			JSON.stringify(
				{
					sandboxId: sandbox.sandboxId,
					template,
					installConcurrency,
					installed,
					failed,
				},
				null,
				2
			)
		);
		console.log(`SANDBOX_ID=${sandbox.sandboxId}`);
	}
}

await main();
