import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { FileType, Sandbox } from "e2b";
import acpAgents from "@corporation/config/acp-agent-manifest";
import { config } from "dotenv";

const packageDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(packageDir, "../..");
const remoteRunnerPath = "/tmp/agent-auth-probe.integration.js";

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
const runAuthE2E = process.env.RUN_AGENT_AUTH_E2E === "1";
const keepTargetSandbox = process.env.KEEP_AGENT_AUTH_TARGET_SANDBOX === "1";
const authSourceSandboxId = process.env.AGENT_AUTH_SOURCE_SANDBOX_ID?.trim() || "";

type CredentialBundlePath = {
	path: string;
	kind: "file" | "dir";
	required?: boolean;
};

type CredentialBundle = {
	schemaVersion: number;
	paths: CredentialBundlePath[];
	exclude?: string[];
};

type AuthCandidateAgent = {
	id: string;
	name: string;
	nativeInstallCommand: string | null | undefined;
	acpInstallCommand: string | null | undefined;
	runtimeCommand: {
		command: string;
		args?: string[];
	};
	credentialBundle: CredentialBundle;
};

const candidateCredentialBundles: Record<string, CredentialBundle> = {
	"claude-acp": {
		schemaVersion: 1,
		paths: [
			{ path: "$HOME/.claude.json", kind: "file", required: true },
			{ path: "$HOME/.claude", kind: "dir", required: false },
		],
	},
	"codex-acp": {
		schemaVersion: 1,
		paths: [{ path: "$HOME/.codex", kind: "dir", required: true }],
	},
};

const candidateAgents = acpAgents
	.filter((agent) => candidateCredentialBundles[agent.id] && agent.runtimeCommand)
	.map((agent) => ({
		id: agent.id,
		name: agent.name,
		nativeInstallCommand: agent.nativeInstallCommand,
		acpInstallCommand: agent.acpInstallCommand,
		runtimeCommand: agent.runtimeCommand!,
		credentialBundle: candidateCredentialBundles[agent.id]!,
	})) as AuthCandidateAgent[];

const describeIf =
	apiKey && runAuthE2E && authSourceSandboxId && candidateAgents.length > 0
		? describe
		: describe.skip;

function sandboxHomePath(path: string) {
	if (path === "$HOME") {
		return "/home/user";
	}
	if (path.startsWith("$HOME/")) {
		return `/home/user/${path.slice("$HOME/".length)}`;
	}
	return path;
}

function shellEscape(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function joinCommands(commands: Array<string | null | undefined>) {
	return commands.filter(Boolean).join("\n");
}

async function installAgentOnSandbox(
	sandbox: Sandbox,
	agent: Pick<
		AuthCandidateAgent,
		"id" | "nativeInstallCommand" | "acpInstallCommand"
	>
): Promise<void> {
	const commands = [
		agent.nativeInstallCommand,
		agent.acpInstallCommand,
	].filter((command): command is string => typeof command === "string");

	for (const command of commands) {
		const result = await sandbox.commands.run(
			joinCommands([`export PATH="$HOME/.local/bin:$PATH"`, command]),
			{
				timeoutMs: 180_000,
			}
		);
		if (result.exitCode !== 0) {
			throw new Error(
				[
					`Failed installing ${agent.id}`,
					result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : null,
					result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : null,
				]
					.filter(Boolean)
					.join("\n\n")
			);
		}
	}
}

async function pathExistsInSandbox(sandbox: Sandbox, path: string): Promise<boolean> {
	const result = await sandbox.commands.run(
		`if test -e ${shellEscape(path)}; then printf present; else printf missing; fi`,
		{
			timeoutMs: 5000,
		}
	);
	return result.stdout.trim() === "present";
}

async function collectSandboxCredentialFiles(
	sandbox: Sandbox,
	agent: AuthCandidateAgent
): Promise<Array<{ path: string; data: Blob }>> {
	const files: Array<{ path: string; data: Blob }> = [];

	for (const entry of agent.credentialBundle.paths) {
		const remotePath = sandboxHomePath(entry.path);
		const exists = await pathExistsInSandbox(sandbox, remotePath);
		if (!exists) {
			if (entry.required) {
				throw new Error(
					`Missing required credential path in source sandbox for ${agent.id}: ${remotePath}`
				);
			}
			continue;
		}

		if (entry.kind === "file") {
			const data = await sandbox.files.read(remotePath, { format: "blob" });
			files.push({ path: remotePath, data });
			continue;
		}

		const listed = await sandbox.files.list(remotePath, { depth: 32 });
		for (const listedEntry of listed) {
			if (listedEntry.type !== FileType.FILE) {
				continue;
			}
			const data = await sandbox.files.read(listedEntry.path, { format: "blob" });
			files.push({ path: listedEntry.path, data });
		}
	}

	return files;
}

async function injectAgentCredentials(
	sourceSandbox: Sandbox,
	sandbox: Sandbox,
	agent: AuthCandidateAgent
): Promise<void> {
	const files = await collectSandboxCredentialFiles(sourceSandbox, agent);
	if (files.length === 0) {
		return;
	}

	for (const file of files) {
		await sandbox.commands.run(
			`mkdir -p ${shellEscape(dirname(file.path))}`,
			{
				timeoutMs: 5000,
			}
		);
	}

	await sandbox.files.write(
		files.map((file) => ({
			path: file.path,
			data: file.data,
		}))
	);
}

async function buildProbeRunnerBundle(): Promise<{
	bundlePath: string;
	tempDir: string;
}> {
	const entrypoint = resolve(
		packageDir,
		"test/helpers/agent-auth-probe-runner.ts"
	);
	const tempDir = await mkdtemp(resolve(tmpdir(), "agent-auth-e2e-"));
	const bundlePath = resolve(tempDir, "agent-auth-probe.js");

	await mkdir(resolve(packageDir, "dist"), { recursive: true });

	const build = Bun.spawnSync([
		"bun",
		"build",
		entrypoint,
		"--outfile",
		bundlePath,
		"--target=bun",
	]);
	if (build.exitCode !== 0) {
		throw new Error(build.stderr.toString().trim() || "bun build failed");
	}

	return { bundlePath, tempDir };
}

describeIf("sandbox-runtime agent auth integration", () => {
	let sandbox: Sandbox | null = null;
	let sourceSandbox: Sandbox | null = null;
	let tempDir: string | null = null;

	beforeAll(async () => {
		const { bundlePath, tempDir: nextTempDir } = await buildProbeRunnerBundle();
		tempDir = nextTempDir;

		sourceSandbox = await Sandbox.connect(authSourceSandboxId, {
			apiKey: apiKey!,
		});
		sandbox = await Sandbox.betaCreate(template, {
			apiKey: apiKey!,
			timeoutMs: 15 * 60_000,
			network: { allowPublicTraffic: true },
			lifecycle: { onTimeout: "pause" },
		});
		console.log(`[agent-auth] target sandbox: ${sandbox.sandboxId}`);

		const bundleData = await readFile(bundlePath);
		await sandbox.files.write([
			{ path: remoteRunnerPath, data: new Blob([bundleData]) },
		]);

		for (const agent of candidateAgents) {
			await installAgentOnSandbox(sourceSandbox, agent);
			await installAgentOnSandbox(sandbox, agent);
			await injectAgentCredentials(sourceSandbox, sandbox, agent);
		}
	});

	afterAll(async () => {
		if (sandbox && !keepTargetSandbox) {
			await Sandbox.kill(sandbox.sandboxId).catch(() => undefined);
		}
		if (tempDir && existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	for (const agent of candidateAgents) {
		test(`${agent.id} completes a real ACP session prompt in a sandbox`, async () => {
			if (!sandbox) {
				throw new Error("sandbox not initialized");
			}

			const result = await sandbox.commands.run(
				`bun ${shellEscape(remoteRunnerPath)} ${shellEscape(agent.id)}`,
				{
					timeoutMs: 60_000,
				}
			);

			if (result.exitCode !== 0) {
				throw new Error(
					[
						`Probe runner failed for ${agent.id}`,
						result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : null,
						result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : null,
					]
						.filter(Boolean)
						.join("\n\n")
				);
			}

			const payload = JSON.parse(result.stdout.trim()) as {
				ok: boolean;
				failedStep?: string | null;
				error?: string | null;
				sessionId?: string | null;
			};

			if (!payload.ok) {
				throw new Error(
					[
						`Expected ${agent.id} to complete ACP prompt successfully`,
						payload.failedStep ? `failedStep: ${payload.failedStep}` : null,
						payload.error ? `error: ${payload.error}` : null,
						`payload: ${JSON.stringify(payload)}`,
					]
						.filter(Boolean)
						.join("\n")
				);
			}

			expect(payload.ok).toBe(true);
			expect(payload.error ?? null).toBeNull();
			expect(payload.sessionId ?? null).toBeTruthy();
		});
	}
});
