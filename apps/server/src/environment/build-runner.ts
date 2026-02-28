import { getGitHubToken } from "@corporation/shared/lib/nango";
import { Sandbox } from "e2b";
import type { BuildConfig, BuildReporter } from "./types";

const BASE_TEMPLATE = "corporation-base";
const REPO_SYNC_TIMEOUT_MS = 15 * 60 * 1000;
const NEEDS_QUOTING_RE = /[\s"'#]/;

type RunCommandOptions = {
	cwd?: string;
	timeoutMs?: number;
	envs?: Record<string, string>;
};

// ─── Shell helpers ────────────────────────────────────────────────

function quoteShellArg(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

// ─── Env file helpers ─────────────────────────────────────────────

function formatEnvContent(vars: Record<string, string>): string {
	return Object.entries(vars)
		.filter(([key]) => key.trim().length > 0)
		.map(([key, value]) => {
			if (NEEDS_QUOTING_RE.test(value)) {
				return `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
			}
			return `${key}=${value}`;
		})
		.join("\n");
}

// ─── Command execution ───────────────────────────────────────────

type CommandExitErrorLike = {
	exitCode: number;
	stderr: string;
	stdout: string;
};

function isCommandExitError(error: unknown): error is CommandExitErrorLike {
	if (!error || typeof error !== "object") {
		return false;
	}
	const candidate = error as Record<string, unknown>;
	return (
		typeof candidate.exitCode === "number" &&
		typeof candidate.stderr === "string" &&
		typeof candidate.stdout === "string"
	);
}

async function runRootCommand(
	sandbox: Sandbox,
	command: string,
	options: RunCommandOptions = {},
	reporter?: BuildReporter
) {
	try {
		return await sandbox.commands.run(command, {
			...options,
			user: "root",
			onStdout: reporter
				? (data: string) => reporter.appendLog(data)
				: undefined,
			onStderr: reporter
				? (data: string) => reporter.appendLog(data)
				: undefined,
		});
	} catch (error) {
		if (isCommandExitError(error)) {
			const cwdMessage = options.cwd ? ` (cwd: ${options.cwd})` : "";
			throw new Error(
				[
					`Sandbox command failed${cwdMessage}: ${command}`,
					`Exit code: ${error.exitCode}`,
					`stderr: ${error.stderr}`,
					`stdout: ${error.stdout}`,
				].join("\n")
			);
		}
		throw error;
	}
}

async function writeEnvFiles(
	sandbox: Sandbox,
	envByPath: Record<string, Record<string, string>> | null | undefined,
	workdir: string
): Promise<void> {
	const envMap = envByPath ?? {};
	const files: Array<{ path: string; data: string }> = [];

	for (const [rawPath, vars] of Object.entries(envMap)) {
		const content = formatEnvContent(vars);
		if (!content) {
			continue;
		}

		const dir = rawPath === "." ? workdir : `${workdir}/${rawPath}`;
		files.push({ path: `${dir}/.env`, data: content });
	}

	if (files.length > 0) {
		await sandbox.files.writeFiles(files);
	}
}

// ─── Build execution ──────────────────────────────────────────────

export type BuildResult = {
	snapshotId: string;
	snapshotCommitSha?: string;
};

/**
 * Runs a full build: creates sandbox from base template, clones repo,
 * runs setup command, installs agent, creates snapshot.
 */
export async function executeBuild(
	buildConfig: BuildConfig,
	envVars: {
		nangoSecretKey: string;
		anthropicApiKey: string;
		e2bApiKey: string;
	},
	reporter: BuildReporter
): Promise<BuildResult> {
	const { config } = buildConfig;
	const { repository } = config;
	const workdir = `/root/${repository.owner}-${repository.name}`;

	const githubToken = await getGitHubToken(
		envVars.nangoSecretKey,
		buildConfig.userId
	);

	if (buildConfig.type === "override") {
		return executeOverrideBuild(buildConfig, reporter);
	}

	const templateOrSnapshot =
		buildConfig.type === "rebuild" && buildConfig.snapshotId
			? buildConfig.snapshotId
			: BASE_TEMPLATE;
	const isRebuild = templateOrSnapshot !== BASE_TEMPLATE;

	const sandbox = await Sandbox.betaCreate(templateOrSnapshot, {
		envs: { ANTHROPIC_API_KEY: envVars.anthropicApiKey },
		network: { allowPublicTraffic: true },
		apiKey: envVars.e2bApiKey,
	});

	try {
		const mode = isRebuild ? "pull" : "clone";
		const repoUrl = `https://x-access-token:${githubToken}@github.com/${repository.owner}/${repository.name}.git`;
		const safeRepoUrl = quoteShellArg(repoUrl);
		const safeWorkdir = quoteShellArg(workdir);
		const safeDefaultBranch = quoteShellArg(repository.defaultBranch);

		// Step: cloning
		reporter.setStep("cloning");
		if (mode === "clone") {
			await runRootCommand(
				sandbox,
				`git clone ${safeRepoUrl} ${safeWorkdir} --branch ${safeDefaultBranch} --single-branch`,
				{ timeoutMs: REPO_SYNC_TIMEOUT_MS },
				reporter
			);
		} else {
			await runRootCommand(
				sandbox,
				`git remote set-url origin ${safeRepoUrl} && git pull origin ${safeDefaultBranch}`,
				{ cwd: workdir, timeoutMs: REPO_SYNC_TIMEOUT_MS },
				reporter
			);
		}

		// Step: writing env files
		reporter.setStep("writing_env");
		await writeEnvFiles(sandbox, config.envByPath, workdir);
		reporter.appendLog("Environment files written.\n");

		// Step: setup command
		reporter.setStep("setup_command");
		await runRootCommand(
			sandbox,
			config.setupCommand,
			{ cwd: workdir, timeoutMs: REPO_SYNC_TIMEOUT_MS },
			reporter
		);

		// Step: installing agent (only for fresh builds)
		if (!isRebuild) {
			reporter.setStep("installing_agent");
			await runRootCommand(
				sandbox,
				"sandbox-agent install-agent opencode --reinstall",
				{ envs: { ANTHROPIC_API_KEY: envVars.anthropicApiKey } },
				reporter
			);
		}

		// Step: creating snapshot
		reporter.setStep("creating_snapshot");
		reporter.appendLog("Creating snapshot...\n");

		const shaResult = await runRootCommand(sandbox, "git rev-parse HEAD", {
			cwd: workdir,
		});
		const snapshotCommitSha = shaResult.stdout.trim() || undefined;

		const snapshot = await sandbox.createSnapshot();
		reporter.appendLog(`Snapshot created: ${snapshot.snapshotId}\n`);

		return {
			snapshotId: snapshot.snapshotId,
			snapshotCommitSha,
		};
	} finally {
		try {
			await sandbox.kill();
		} catch {
			// Best-effort cleanup
		}
	}
}

/**
 * Override build: connects to an existing running sandbox and creates a snapshot.
 */
async function executeOverrideBuild(
	buildConfig: BuildConfig,
	reporter: BuildReporter
): Promise<BuildResult> {
	if (!buildConfig.sandboxId) {
		throw new Error("sandboxId is required for override builds");
	}

	reporter.setStep("creating_snapshot");
	reporter.appendLog("Connecting to running sandbox...\n");

	const sandbox = await Sandbox.connect(buildConfig.sandboxId);

	reporter.appendLog("Creating snapshot from running sandbox...\n");
	const snapshot = await sandbox.createSnapshot();
	reporter.appendLog(`Snapshot created: ${snapshot.snapshotId}\n`);

	return {
		snapshotId: snapshot.snapshotId,
		snapshotCommitSha: buildConfig.snapshotCommitSha,
	};
}
