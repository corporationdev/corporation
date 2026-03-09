"use node";

import type { Sandbox } from "e2b";
import { quoteShellArg } from "./git";

export const SANDBOX_AGENT_PORT = 5799;
export const BASE_TEMPLATE = "corporation-base";
export const SANDBOX_USER = "user";
export const SANDBOX_HOME_DIR = `/home/${SANDBOX_USER}`;
export const SANDBOX_WORKDIR = "/workspace";
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const SERVER_POLL_INTERVAL_MS = 500;

export const REPO_SYNC_TIMEOUT_MS = 15 * 60 * 1000;
const COMMAND_OUTPUT_MAX_LENGTH = 2000;
export const DEV_SERVER_SESSION_NAME = "devserver";
export const SANDBOX_AGENT_SESSION_NAME = "sandbox-agent";

type CommandExitErrorLike = {
	exitCode: number;
	stderr: string;
	stdout: string;
};
type RunRootCommandOptions = Omit<
	NonNullable<Parameters<Sandbox["commands"]["run"]>[1]>,
	"user"
>;
type RunWorkspaceCommandOptions = RunRootCommandOptions;

function truncateOutput(
	output: string,
	maxLength = COMMAND_OUTPUT_MAX_LENGTH
): string {
	if (output.length <= maxLength) {
		return output;
	}
	return `${output.slice(0, maxLength)}...`;
}

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

export async function runRootCommand(
	sandbox: Sandbox,
	command: string,
	options: RunRootCommandOptions = {}
) {
	try {
		return await sandbox.commands.run(command, {
			...options,
			user: "root",
		});
	} catch (error) {
		if (isCommandExitError(error)) {
			const cwdMessage = options.cwd ? ` (cwd: ${options.cwd})` : "";
			throw new Error(
				[
					`Sandbox command failed${cwdMessage}: ${command}`,
					`Exit code: ${error.exitCode}`,
					`stderr: ${truncateOutput(error.stderr)}`,
					`stdout: ${truncateOutput(error.stdout)}`,
				].join("\n")
			);
		}
		throw error;
	}
}

export async function runWorkspaceCommand(
	sandbox: Sandbox,
	command: string,
	options: RunWorkspaceCommandOptions = {}
) {
	try {
		return await sandbox.commands.run(command, {
			...options,
			user: SANDBOX_USER,
		});
	} catch (error) {
		if (isCommandExitError(error)) {
			const cwdMessage = options.cwd ? ` (cwd: ${options.cwd})` : "";
			throw new Error(
				[
					`Sandbox command failed${cwdMessage}: ${command}`,
					`Exit code: ${error.exitCode}`,
					`stderr: ${truncateOutput(error.stderr)}`,
					`stdout: ${truncateOutput(error.stdout)}`,
				].join("\n")
			);
		}
		throw error;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export type BootServerOptions = {
	sessionName: string;
	command: string;
	healthUrl: string;
	workdir?: string;
	appendLog?: (chunk: string) => void;
};

export async function bootServer(
	sandbox: Sandbox,
	opts: BootServerOptions
): Promise<void> {
	const { sessionName, command, healthUrl, workdir, appendLog } = opts;

	appendLog?.(`Starting ${sessionName} (tmux session)...\n`);

	const cwdFlag = workdir ? `-c ${quoteShellArg(workdir)} ` : "";
	await runWorkspaceCommand(
		sandbox,
		`tmux new-session -d -s ${sessionName} ${cwdFlag}${quoteShellArg(command)} \\; set-option -t ${sessionName} mouse on \\; set-option -t ${sessionName} status off`
	);

	appendLog?.(`Waiting for ${sessionName} to be ready...\n`);

	const deadline = Date.now() + SERVER_STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			await sandbox.commands.run(`curl -sf --max-time 2 ${healthUrl}`);
			appendLog?.(`${sessionName} is ready.\n`);
			return;
		} catch (error) {
			if (!isCommandExitError(error)) {
				throw error;
			}
		}

		try {
			await sandbox.commands.run(`tmux has-session -t ${sessionName}`);
		} catch (error) {
			if (isCommandExitError(error)) {
				throw new Error(`${sessionName} process exited before becoming ready`);
			}
			throw error;
		}

		await sleep(SERVER_POLL_INTERVAL_MS);
	}

	throw new Error(
		`${sessionName} did not become ready within ${SERVER_STARTUP_TIMEOUT_MS / 1000}s`
	);
}

export async function killDevServer(sandbox: Sandbox): Promise<void> {
	try {
		await runWorkspaceCommand(
			sandbox,
			`tmux kill-session -t ${DEV_SERVER_SESSION_NAME}`
		);
	} catch (error) {
		if (isCommandExitError(error)) {
			return;
		}
		throw error;
	}
}

export async function hasDevServerSession(sandbox: Sandbox): Promise<boolean> {
	try {
		await runWorkspaceCommand(
			sandbox,
			`tmux has-session -t ${DEV_SERVER_SESSION_NAME}`
		);
		return true;
	} catch (error) {
		if (isCommandExitError(error)) {
			return false;
		}
		throw error;
	}
}
