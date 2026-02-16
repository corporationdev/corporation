import { env } from "cloudflare:workers";
import { createLogger } from "@corporation/logger";
import { Daytona, type PtyHandle, type Sandbox } from "@daytonaio/sdk";
import { actor } from "rivetkit";

const log = createLogger("terminal");

// ---------------------------------------------------------------------------
// State & Vars types
// ---------------------------------------------------------------------------

export type TerminalState = {
	sandboxId: string;
	sandboxUrl: string;
	ptySessionId: string;
};

export type TerminalVars = {
	sandbox: Sandbox;
	ptyHandle: PtyHandle;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDaytona(): Daytona {
	return new Daytona({
		apiKey: (env as unknown as Env).DAYTONA_API_KEY,
	});
}

async function connectOrCreatePty(
	sandbox: Sandbox,
	ptySessionId: string,
	onData: (data: Uint8Array) => void
): Promise<{ handle: PtyHandle; sessionId: string }> {
	// Try reconnecting to the existing PTY session
	try {
		const handle = await sandbox.process.connectPty(ptySessionId, { onData });
		log.debug({ ptySessionId }, "reconnected to existing pty session");
		return { handle, sessionId: ptySessionId };
	} catch {
		log.warn({ ptySessionId }, "failed to reconnect pty, creating new session");
	}

	// Create a new PTY session
	const workDir = await sandbox.getWorkDir();
	const newId = crypto.randomUUID();
	const handle = await sandbox.process.createPty({
		id: newId,
		cwd: workDir,
		cols: 120,
		rows: 30,
		onData,
	});
	log.info({ ptySessionId: newId }, "created new pty session");
	return { handle, sessionId: newId };
}

// ---------------------------------------------------------------------------
// Actor definition
// ---------------------------------------------------------------------------

export const terminal = actor({
	createState: async (
		c,
		input: { sandboxId: string; sandboxUrl: string }
	): Promise<TerminalState> => {
		const sandboxId = c.key[0];
		if (!sandboxId) {
			throw new Error("Actor key must contain a sandboxId");
		}

		log.info(
			{ sandboxId, sandboxUrl: input.sandboxUrl },
			"terminal actor created"
		);

		// Create initial PTY session
		const daytona = getDaytona();
		const sandbox = await daytona.get(input.sandboxId);
		const workDir = await sandbox.getWorkDir();
		const ptySessionId = crypto.randomUUID();
		const handle = await sandbox.process.createPty({
			id: ptySessionId,
			cwd: workDir,
			cols: 120,
			rows: 30,
			// biome-ignore lint/suspicious/noEmptyBlockStatements: noop placeholder for initial PTY creation
			onData: () => {},
		});
		await handle.disconnect();

		return {
			sandboxId: input.sandboxId,
			sandboxUrl: input.sandboxUrl,
			ptySessionId,
		};
	},

	createVars: async (c): Promise<TerminalVars> => {
		const daytona = getDaytona();
		const sandbox = await daytona.get(c.state.sandboxId);

		const onData = (data: Uint8Array) => {
			c.broadcast("output", Array.from(data));
		};

		const { handle, sessionId } = await connectOrCreatePty(
			sandbox,
			c.state.ptySessionId,
			onData
		);

		if (sessionId !== c.state.ptySessionId) {
			c.state.ptySessionId = sessionId;
		}

		return { sandbox, ptyHandle: handle };
	},

	onWake: (c) => {
		setTimeout(() => {
			log.debug({ sandboxId: c.state.sandboxId }, "terminal actor woke");

			// Keep the actor alive while the PTY WebSocket is open.
			// The PTY handle's internal WebSocket will close when the shell
			// exits or the sandbox stops, at which point this promise resolves.
			c.waitUntil(
				c.vars.ptyHandle.wait().then((result) => {
					log.info(
						{
							sandboxId: c.state.sandboxId,
							exitCode: result.exitCode,
							error: result.error,
						},
						"pty session ended"
					);
				})
			);
		}, 0);
	},

	actions: {
		input: async (c, data: number[]) => {
			await c.vars.ptyHandle.sendInput(new Uint8Array(data));
		},

		resize: async (c, cols: number, rows: number) => {
			await c.vars.ptyHandle.resize(cols, rows);
		},
	},
});
