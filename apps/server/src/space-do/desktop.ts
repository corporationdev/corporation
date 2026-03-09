import { requireSandbox } from "./sandbox";
import type { SpaceRuntimeContext } from "./types";

const DISPLAY = ":0";

function tryGetExistingStreamUrl(c: SpaceRuntimeContext): string | null {
	try {
		const sandbox = c.vars.sandbox;
		if (!sandbox) {
			return null;
		}
		const url = sandbox.stream.getUrl();
		return typeof url === "string" && url.length > 0 ? url : null;
	} catch {
		return null;
	}
}

export async function getDesktopStreamUrl(
	c: SpaceRuntimeContext
): Promise<string> {
	const sandbox = requireSandbox(c);

	// Start Xvfb if not already running (connect() doesn't start the desktop)
	try {
		await sandbox.commands.run(`xdpyinfo -display ${DISPLAY}`);
	} catch {
		await sandbox.commands.run(
			`Xvfb ${DISPLAY} -ac -screen 0 1024x768x24 -retro -dpi 96 -nolisten tcp -nolisten unix`,
			{ background: true, timeoutMs: 0 }
		);
		// Wait for Xvfb to be ready
		for (let i = 0; i < 20; i++) {
			try {
				await sandbox.commands.run(`xdpyinfo -display ${DISPLAY}`);
				break;
			} catch {
				await new Promise((r) => setTimeout(r, 500));
			}
		}
		// Start XFCE desktop session
		await sandbox.commands.run("startxfce4", {
			background: true,
			timeoutMs: 0,
			envs: { DISPLAY },
		});
	}

	sandbox.display = DISPLAY;

	// If the stream is already running, reuse it. Avoid stop/start churn,
	// which can invalidate the previously issued stream URL.
	const existingUrl = tryGetExistingStreamUrl(c);
	if (existingUrl) {
		return existingUrl;
	}

	try {
		await sandbox.stream.start();
		const url = tryGetExistingStreamUrl(c);
		if (url) {
			return url;
		}
		throw new Error("Desktop stream started without a URL");
	} catch {
		// Recovery path for stale VNC state in the sandbox SDK/process.
	}

	try {
		await sandbox.stream.stop();
	} catch {
		// May not be running — that's fine
	}
	await sandbox.stream.start();
	const url = tryGetExistingStreamUrl(c);
	if (!url) {
		throw new Error("Desktop stream unavailable");
	}
	return url;
}
