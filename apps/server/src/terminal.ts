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
	ptySessionId: string | null;
	scrollback: number[];
};

export type TerminalVars = {
	ptyHandle: PtyHandle;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function connectOrCreatePty(
	sandbox: Sandbox,
	ptySessionId: string | null,
	onData: (data: Uint8Array) => void
): Promise<{ handle: PtyHandle; sessionId: string }> {
	// Try reconnecting to the existing PTY session
	if (ptySessionId) {
		try {
			const handle = await sandbox.process.connectPty(ptySessionId, { onData });
			log.debug({ ptySessionId }, "reconnected to existing pty session");
			return { handle, sessionId: ptySessionId };
		} catch {
			log.warn(
				{ ptySessionId },
				"failed to reconnect pty, creating new session"
			);
		}
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
	createState: (c, input: { sandboxId: string }): TerminalState => {
		const sandboxId = c.key[0];
		if (!sandboxId) {
			throw new Error("Actor key must contain a sandboxId");
		}

		return {
			sandboxId: input.sandboxId,
			ptySessionId: null,
			scrollback: [],
		};
	},

	createVars: async (c): Promise<TerminalVars> => {
		const daytona = new Daytona({ apiKey: env.DAYTONA_API_KEY });
		const sandbox = await daytona.get(c.state.sandboxId);

		const onData = (data: Uint8Array) => {
			const bytes = Array.from(data);

			// Append to scrollback buffer, trimming from the front if over limit
			c.state.scrollback = c.state.scrollback.concat(bytes);
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

		return { ptyHandle: handle };
	},

	onSleep: async (c) => {
		await c.vars.ptyHandle.disconnect();
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
