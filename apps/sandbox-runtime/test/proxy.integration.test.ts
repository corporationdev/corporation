import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { config } from "dotenv";
import { Sandbox } from "e2b";
import {
	buildLocalProxyEnv,
	getLocalProxyConfig,
	LOCAL_PROXY_LOG_PATH,
	LOCAL_PROXY_STDERR_PATH,
} from "../src/proxy";

const packageDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(packageDir, "../..");

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
const runtimePort = 5799;
const runtimeSessionName = "sandbox-runtime-test";
const remoteBundlePath = "/tmp/sandbox-runtime.integration.js";
const runtimeLogPath = "/tmp/sandbox-runtime.integration.log";
const runtimeStderrPath = "/tmp/sandbox-runtime.integration.stderr.log";

const describeIf = apiKey ? describe : describe.skip;
const proxyConfig = getLocalProxyConfig();

function shellEscape(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildEnvPrefix(env: Record<string, string>): string {
	return Object.entries(env)
		.map(([key, value]) => `${key}=${shellEscape(value)}`)
		.join(" ");
}

async function waitForRuntimeHealth(sandbox: Sandbox): Promise<void> {
	const deadline = Date.now() + 30_000;

	while (Date.now() < deadline) {
		try {
			await sandbox.commands.run(
				`curl -sf http://localhost:${runtimePort}/health`,
				{ timeoutMs: 3000 }
			);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}

	const stderrOutput = await sandbox.commands
		.run(`cat ${runtimeStderrPath}`, { timeoutMs: 3000 })
		.then((result) => result.stdout.trim())
		.catch(() => "");

	throw new Error(
		stderrOutput
			? `sandbox-runtime did not become healthy:\n${stderrOutput}`
			: "sandbox-runtime did not become healthy"
	);
}

describeIf("sandbox-runtime proxy integration", () => {
	let sandbox: Sandbox | null = null;
	let tempDir: string | null = null;

	beforeAll(async () => {
		const entrypoint = resolve(packageDir, "src/index.ts");
		tempDir = await mkdtemp(resolve(tmpdir(), "sandbox-runtime-test-"));
		const bundlePath = resolve(tempDir, "sandbox-runtime.js");

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

		sandbox = await Sandbox.create(template, {
			apiKey,
			timeoutMs: 15 * 60_000,
			network: { allowPublicTraffic: true },
		});

		const bundleData = await readFile(bundlePath);
		await sandbox.files.write([
			{ path: remoteBundlePath, data: new Blob([bundleData]) },
		]);

		await sandbox.commands.run(
			`tmux kill-session -t ${runtimeSessionName} || true`,
			{
				timeoutMs: 5000,
			}
		);
		await sandbox.commands.run(`fuser -k ${runtimePort}/tcp || true`, {
			timeoutMs: 5000,
		});
		await sandbox.commands.run(
			`: > ${runtimeLogPath}; : > ${runtimeStderrPath}`,
			{
				timeoutMs: 3000,
			}
		);
		await sandbox.commands.run(
			`tmux new-session -d -s ${runtimeSessionName} "bun ${remoteBundlePath} --host 0.0.0.0 --port ${runtimePort} >> ${runtimeLogPath} 2>> ${runtimeStderrPath}"`,
			{ timeoutMs: 5000 }
		);

		await waitForRuntimeHealth(sandbox);
	});

	afterAll(async () => {
		if (sandbox) {
			await Sandbox.kill(sandbox.sandboxId).catch(() => undefined);
		}
		if (tempDir && existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("starts the sandbox proxy and proxies HTTPS traffic", async () => {
		const currentSandbox = sandbox;
		if (!currentSandbox) {
			throw new Error("sandbox not initialized");
		}

		const processResult = await currentSandbox.commands.run(
			"pgrep -af mitmdump",
			{
				timeoutMs: 5000,
			}
		);
		expect(processResult.stdout).toContain("mitmdump");

		const certResult = await currentSandbox.commands.run(
			`test -f ${shellEscape(proxyConfig.caCertPath)} && echo ok`,
			{ timeoutMs: 5000 }
		);
		expect(certResult.stdout.trim()).toBe("ok");

		const result = await currentSandbox.commands.run(
			`${buildEnvPrefix(buildLocalProxyEnv())} curl -sS -o /tmp/proxy-test.html -w '%{http_code}' https://example.com`,
			{ timeoutMs: 20_000 }
		);

		if (result.stdout.trim() !== "200") {
			const proxyLog = await currentSandbox.commands
				.run(`tail -n 50 ${shellEscape(LOCAL_PROXY_LOG_PATH)}`, {
					timeoutMs: 5000,
				})
				.then((output) => output.stdout.trim())
				.catch(() => "");
			const proxyStderr = await currentSandbox.commands
				.run(`tail -n 50 ${shellEscape(LOCAL_PROXY_STDERR_PATH)}`, {
					timeoutMs: 5000,
				})
				.then((output) => output.stdout.trim())
				.catch(() => "");
			const responseBody = await currentSandbox.commands
				.run("cat /tmp/proxy-test.html", { timeoutMs: 5000 })
				.then((output) => output.stdout.trim())
				.catch(() => "");

			throw new Error(
				[
					`expected 200 from proxied curl, got ${result.stdout.trim() || "<empty>"}`,
					result.stderr ? `curl stderr: ${result.stderr.trim()}` : null,
					responseBody ? `curl body: ${responseBody}` : null,
					proxyLog ? `proxy log:\n${proxyLog}` : null,
					proxyStderr ? `proxy stderr:\n${proxyStderr}` : null,
				]
					.filter(Boolean)
					.join("\n\n")
			);
		}

		expect(result.stdout.trim()).toBe("200");
	});
});
