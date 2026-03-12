import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MCP_SESSION_CWD_ENV } from "./mcp-tools";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const DEFAULT_CWD = process.env[MCP_SESSION_CWD_ENV] || process.cwd();

type ExecutionResult = {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
};

type ProcessExecutionError = Error & {
	code?: number | string;
	killed?: boolean;
};

function resolveCwd(cwd: string | undefined): string {
	return cwd ? resolve(DEFAULT_CWD, cwd) : DEFAULT_CWD;
}

function formatExecutionResult(result: ExecutionResult): string {
	return JSON.stringify(result, null, 2);
}

function runBun(
	args: string[],
	cwd: string,
	timeoutMs: number
): Promise<ExecutionResult> {
	return new Promise((resolvePromise, reject) => {
		const startedAt = Date.now();

		execFile(
			"bun",
			["run", "--no-install", ...args],
			{
				cwd,
				env: process.env,
				timeout: timeoutMs,
				maxBuffer: MAX_BUFFER_BYTES,
			},
			(error, stdout, stderr) => {
				const durationMs = Date.now() - startedAt;

				if (!error) {
					resolvePromise({
						exitCode: 0,
						stdout,
						stderr,
						durationMs,
						timedOut: false,
					});
					return;
				}

				const processError = error as ProcessExecutionError;
				if (
					typeof processError.code === "number" ||
					processError.killed === true
				) {
					resolvePromise({
						exitCode:
							typeof processError.code === "number" ? processError.code : null,
						stdout,
						stderr: stderr || error.message,
						durationMs,
						timedOut: processError.killed === true,
					});
					return;
				}

				reject(error);
			}
		);
	});
}

export async function runCodeMcp(): Promise<void> {
	const server = new McpServer({
		name: "code",
		version: "1.0.1",
	});

	server.registerTool(
		"execute_code",
		{
			description:
				"Execute inline TypeScript or JavaScript with Bun in the current project context",
			inputSchema: {
				code: z
					.string()
					.min(1)
					.describe("The TypeScript or JavaScript code to run"),
				cwd: z
					.string()
					.optional()
					.describe("Optional working directory relative to the session cwd"),
				args: z
					.array(z.string())
					.default([])
					.describe("Optional command-line arguments passed to the script"),
				timeoutMs: z
					.number()
					.int()
					.min(1)
					.max(MAX_TIMEOUT_MS)
					.default(DEFAULT_TIMEOUT_MS)
					.describe("Execution timeout in milliseconds"),
			},
		},
		async ({ code, cwd, args, timeoutMs }) => {
			const resolvedCwd = resolveCwd(cwd);
			const tempDir = await mkdtemp(`${tmpdir()}/sandbox-runtime-code-`);
			const filePath = `${tempDir}/inline.ts`;

			try {
				await writeFile(filePath, code, "utf8");
				const result = await runBun(
					[filePath, ...args],
					resolvedCwd,
					timeoutMs
				);
				return {
					content: [{ type: "text", text: formatExecutionResult(result) }],
				};
			} finally {
				await rm(tempDir, { recursive: true, force: true });
			}
		}
	);

	server.registerTool(
		"execute_file",
		{
			description:
				"Execute an existing TypeScript or JavaScript file with Bun in the current project context",
			inputSchema: {
				path: z
					.string()
					.min(1)
					.describe(
						"Path to the file to run, relative to the working directory unless absolute"
					),
				cwd: z
					.string()
					.optional()
					.describe("Optional working directory relative to the session cwd"),
				args: z
					.array(z.string())
					.default([])
					.describe("Optional command-line arguments passed to the file"),
				timeoutMs: z
					.number()
					.int()
					.min(1)
					.max(MAX_TIMEOUT_MS)
					.default(DEFAULT_TIMEOUT_MS)
					.describe("Execution timeout in milliseconds"),
			},
		},
		async ({ path, cwd, args, timeoutMs }) => {
			const resolvedCwd = resolveCwd(cwd);
			const filePath = resolve(resolvedCwd, path);
			const fileStats = await stat(filePath).catch(() => null);

			if (!fileStats?.isFile()) {
				throw new Error(`File not found: ${filePath}`);
			}

			const result = await runBun(
				[filePath, ...args],
				dirname(filePath),
				timeoutMs
			);
			return {
				content: [{ type: "text", text: formatExecutionResult(result) }],
			};
		}
	);

	const transport = new StdioServerTransport();
	await server.connect(transport);
}
