import { execFile } from "node:child_process";
import type { Browser, BrowserContext } from "playwright";

export const DISPLAY = ":0";
export const CHROMIUM_CDP_URL = "http://127.0.0.1:9222";

const PLAYWRIGHT_BROWSERS_PATH = "/opt/playwright-browsers";
const CHROMIUM_USER_DATA_DIR = "/tmp/corporation-chromium-profile";
const DEFAULT_TIMEOUT_MS = 30_000;
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 800;

type ManagedBrowserHandle = {
	close: () => Promise<void>;
};

type RunOptions = {
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
};

process.env.PLAYWRIGHT_BROWSERS_PATH ??= PLAYWRIGHT_BROWSERS_PATH;

function envWithDisplay(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		...process.env,
		DISPLAY,
		PLAYWRIGHT_BROWSERS_PATH,
		...extraEnv,
	};
}

function run(
	command: string,
	args: string[],
	options?: RunOptions
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{
				env: envWithDisplay(options?.env),
				timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				maxBuffer: 10 * 1024 * 1024,
			},
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error(`${command} failed: ${stderr || error.message}`));
					return;
				}
				resolve({ stdout, stderr });
			}
		);
	});
}

async function commandSucceeds(
	command: string,
	args: string[],
	options?: RunOptions
): Promise<boolean> {
	try {
		await run(command, args, options);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(
	check: () => Promise<boolean>,
	label: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	intervalMs = 250
): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (await check()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function isDisplayReady(): Promise<boolean> {
	return await commandSucceeds("xdpyinfo", ["-display", DISPLAY], {
		timeoutMs: 5000,
	});
}

async function isXfceReady(): Promise<boolean> {
	return await commandSucceeds("pgrep", ["-f", "xfce4-session"], {
		timeoutMs: 5000,
	});
}

async function isChromiumReady(): Promise<boolean> {
	try {
		const response = await fetch(`${CHROMIUM_CDP_URL}/json/version`);
		return response.ok;
	} catch {
		return false;
	}
}

async function startXvfb(): Promise<void> {
	if (await isDisplayReady()) {
		return;
	}

	await run("bash", [
		"-lc",
		[
			"nohup Xvfb :0 -ac -screen 0 1280x800x24 -dpi 96 -nolisten tcp -nolisten unix",
			">/tmp/corporation-xvfb.log 2>&1 < /dev/null &",
		].join(" "),
	]);

	await waitFor(isDisplayReady, "Xvfb display");
}

async function startXfce(): Promise<void> {
	if (await isXfceReady()) {
		return;
	}

	await run(
		"bash",
		["-lc", "nohup startxfce4 >/tmp/corporation-xfce.log 2>&1 < /dev/null &"],
		{ env: { DISPLAY } }
	);

	await waitFor(isXfceReady, "XFCE session");
}

export async function ensureDesktopEnvironment(): Promise<void> {
	await startXvfb();
	await startXfce();
}

export async function ensureManagedBrowserStarted(): Promise<ManagedBrowserHandle> {
	await ensureDesktopEnvironment();

	if (await isChromiumReady()) {
		return {
			close: async () => undefined,
		};
	}

	const { chromium } = await import("playwright");
	const context = await chromium.launchPersistentContext(
		CHROMIUM_USER_DATA_DIR,
		{
			headless: false,
			viewport: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
			env: envWithDisplay(),
			args: [
				"--remote-debugging-address=127.0.0.1",
				"--remote-debugging-port=9222",
				`--window-size=${WINDOW_WIDTH},${WINDOW_HEIGHT}`,
				"--window-position=0,0",
				"--disable-dev-shm-usage",
				"--disable-session-crashed-bubble",
				"--no-first-run",
				"--no-default-browser-check",
			],
		}
	);

	if (context.pages().length === 0) {
		const page = await context.newPage();
		await page.goto("about:blank");
	}

	await waitFor(isChromiumReady, "Chromium CDP endpoint");

	return {
		close: async () => {
			await context.close();
		},
	};
}

export async function waitForManagedBrowser(timeoutMs = DEFAULT_TIMEOUT_MS) {
	await waitFor(isChromiumReady, "managed Chromium", timeoutMs);
}

async function getConnectedBrowser(): Promise<Browser> {
	await waitForManagedBrowser();
	const { chromium } = await import("playwright");
	return await chromium.connectOverCDP(CHROMIUM_CDP_URL);
}

export async function connectToManagedBrowser(): Promise<{
	browser: Browser;
	context: BrowserContext;
}> {
	const browser = await getConnectedBrowser();
	const context = browser.contexts()[0];
	if (!context) {
		await browser.close();
		throw new Error("Chromium default context is unavailable");
	}
	return { browser, context };
}
