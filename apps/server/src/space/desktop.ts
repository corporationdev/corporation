import type { SpaceRuntimeContext } from "./types";

const DISPLAY = ":0";

export async function getDesktopStreamUrl(
	c: SpaceRuntimeContext
): Promise<string> {
	const { sandbox } = c.vars;

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
	// Stop any stale VNC processes so the SDK's internal state is clean
	try {
		await sandbox.stream.stop();
	} catch {
		// May not be running — that's fine
	}
	await sandbox.stream.start();
	return sandbox.stream.getUrl();
}
