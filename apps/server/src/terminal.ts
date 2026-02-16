import { env } from "@corporation/env/server";
import { createLogger } from "@corporation/logger";
import type { PtyHandle, Sandbox } from "@daytonaio/sdk";
import { Daytona } from "@daytonaio/sdk";
import { actor } from "rivetkit";

const log = createLogger("terminal");

// ---------------------------------------------------------------------------
// State & Vars types
// ---------------------------------------------------------------------------

// ~256 KB scrollback buffer
const MAX_SCROLLBACK_BYTES = 256 * 1024;

export type TerminalState = {
	sandboxId: string;
	sandboxUrl: string;
	ptySessionId: string;
	scrollback: number[];
};

export type TerminalVars = {
	sandbox: Sandbox;
	ptyHandle: PtyHandle;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
	createState: (
		c,
		input: { sandboxId: string; sandboxUrl: string }
	): TerminalState => {
		const sandboxId = c.key[0];
		if (!sandboxId) {
			throw new Error("Actor key must contain a sandboxId");
		}

		log.info(
			{ sandboxId, sandboxUrl: input.sandboxUrl },
			"terminal actor created"
		);

		return {
			sandboxId: input.sandboxId,
			sandboxUrl: input.sandboxUrl,
			ptySessionId: crypto.randomUUID(),
			scrollback: [],
		};
	},

	createVars: async (c): Promise<TerminalVars> => {
		const daytona = new Daytona({ apiKey: env.DAYTONA_API_KEY });
		const sandbox = await daytona.get(c.state.sandboxId);

		const onData = (data: Uint8Array) => {
			const bytes = Array.from(data);

			// Append to scrollback buffer, trimming from the front if over limit
			c.state.scrollback.push(...bytes);
			if (c.state.scrollback.length > MAX_SCROLLBACK_BYTES) {
				c.state.scrollback = c.state.scrollback.slice(
					c.state.scrollback.length - MAX_SCROLLBACK_BYTES
				);
			}

			c.broadcast("output", bytes);
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
		getScrollback: (c) => {
			return c.state.scrollback;
		},

		input: async (c, data: number[]) => {
			await c.vars.ptyHandle.sendInput(new Uint8Array(data));
		},

		resize: async (c, cols: number, rows: number) => {
			await c.vars.ptyHandle.resize(cols, rows);
		},
	},
});
