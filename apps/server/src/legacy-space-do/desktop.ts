import type { Sandbox } from "@e2b/desktop";
import { ensureSandboxConnected } from "./sandbox";
import type { SpaceRuntimeContext } from "./types";

const DISPLAY = ":0";

function tryGetExistingStreamUrl(sandbox: Sandbox): string | null {
	try {
		const url = sandbox.stream.getUrl();
		return typeof url === "string" && url.length > 0 ? url : null;
	} catch {
		return null;
	}
}

export async function getDesktopStreamUrl(
	c: SpaceRuntimeContext
): Promise<string> {
	const sandbox = await ensureSandboxConnected(c);

	sandbox.display = DISPLAY;

	// If the stream is already running, reuse it. Avoid stop/start churn,
	// which can invalidate the previously issued stream URL.
	const existingUrl = tryGetExistingStreamUrl(sandbox);
	if (existingUrl) {
		return existingUrl;
	}

	try {
		await sandbox.stream.start();
		const url = tryGetExistingStreamUrl(sandbox);
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
	const url = tryGetExistingStreamUrl(sandbox);
	if (!url) {
		throw new Error("Desktop stream unavailable");
	}
	return url;
}
