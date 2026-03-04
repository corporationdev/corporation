import { CommandExitError, Sandbox } from "e2b";
import { Hono } from "hono";
import { authMiddleware } from "./auth";

const CODE_SERVER_PORT = 8080;
const CODE_SERVER_SESSION_NAME = "codeserver";

async function isCodeServerRunning(sandbox: Sandbox): Promise<boolean> {
	try {
		await sandbox.commands.run(
			`tmux has-session -t ${CODE_SERVER_SESSION_NAME}`,
			{ user: "root" }
		);
		return true;
	} catch (error) {
		if (error instanceof CommandExitError) {
			return false;
		}
		throw error;
	}
}

async function isCodeServerInstalled(sandbox: Sandbox): Promise<boolean> {
	try {
		await sandbox.commands.run("which code-server", { user: "root" });
		return true;
	} catch (error) {
		if (error instanceof CommandExitError) {
			return false;
		}
		throw error;
	}
}

async function installCodeServer(sandbox: Sandbox): Promise<void> {
	await sandbox.commands.run(
		"curl -fsSL https://code-server.dev/install.sh | sh",
		{
			user: "root",
			timeoutMs: 120_000,
		}
	);
}

async function startCodeServer(sandbox: Sandbox): Promise<void> {
	// Get the workdir (assumes standard /root/owner-repo structure)
	let workdir = "/root";
	try {
		const result = await sandbox.commands.run("pwd", { user: "root" });
		if (result.stdout.trim()) {
			workdir = result.stdout.trim();
		}
	} catch {
		// Use default workdir
	}

	// Start code-server in tmux
	await sandbox.commands.run(
		`tmux new-session -d -s ${CODE_SERVER_SESSION_NAME} -c '${workdir}' "code-server --bind-addr 0.0.0.0:${CODE_SERVER_PORT} --auth none '${workdir}'"`,
		{ user: "root" }
	);

	// Configure tmux session
	await sandbox.commands.run(
		`tmux set-option -t ${CODE_SERVER_SESSION_NAME} mouse on \\; set-option -t ${CODE_SERVER_SESSION_NAME} status off`,
		{ user: "root" }
	);
}

async function ensureCodeServerRunning(sandbox: Sandbox): Promise<void> {
	// Check if already running
	if (await isCodeServerRunning(sandbox)) {
		return;
	}

	// Install if needed
	if (!(await isCodeServerInstalled(sandbox))) {
		await installCodeServer(sandbox);
	}

	// Start code-server
	await startCodeServer(sandbox);

	// Wait for it to be ready
	const maxAttempts = 30;
	for (let i = 0; i < maxAttempts; i++) {
		try {
			await sandbox.commands.run(
				`curl -sf --max-time 2 http://localhost:${CODE_SERVER_PORT}/`,
				{ user: "root" }
			);
			return; // Ready!
		} catch (error) {
			if (error instanceof CommandExitError) {
				// Not ready yet, wait and retry
				await new Promise((resolve) => setTimeout(resolve, 1000));
				continue;
			}
			throw error;
		}
	}

	throw new Error("code-server failed to start within timeout");
}

export const sandboxApp = new Hono<{ Bindings: Env }>()
	.use(authMiddleware)
	.get("/preview", async (c) => {
		const sandboxId = c.req.query("sandboxId");
		const portStr = c.req.query("port");

		if (!(sandboxId && portStr)) {
			return c.json({ error: "sandboxId and port are required" }, 400);
		}

		const port = Number.parseInt(portStr, 10);
		if (Number.isNaN(port) || port < 1 || port > 65_535) {
			return c.json({ error: "Invalid port" }, 400);
		}

		const sandbox = await Sandbox.connect(sandboxId, {
			apiKey: c.env.E2B_API_KEY,
		});
		const url = `https://${sandbox.getHost(port)}`;

		return c.json({ url });
	})
	.get("/code-server", async (c) => {
		const sandboxId = c.req.query("sandboxId");

		if (!sandboxId) {
			return c.json({ error: "sandboxId is required" }, 400);
		}

		try {
			const sandbox = await Sandbox.connect(sandboxId, {
				apiKey: c.env.E2B_API_KEY,
			});

			// Ensure code-server is running (install and start if needed)
			await ensureCodeServerRunning(sandbox);

			// Return the URL
			const url = `https://${sandbox.getHost(CODE_SERVER_PORT)}`;
			return c.json({ url });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.json({ error: `Failed to start code-server: ${message}` }, 500);
		}
	});
