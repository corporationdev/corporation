/// <reference lib="dom" />

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type {
	Browser,
	BrowserContext,
	ConsoleMessage,
	Page,
	Response,
} from "playwright";
import { z } from "zod";
import {
	connectToManagedBrowser,
	waitForManagedBrowser,
} from "./desktop-browser";

const MAX_LOG_ENTRIES = 200;
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;

type ConsoleLogEntry = {
	type: string;
	text: string;
	location: string | null;
	timestamp: number;
};

type NetworkLogEntry = {
	kind: "request" | "response" | "request_failed";
	method: string;
	url: string;
	status: number | null;
	resourceType: string;
	errorText: string | null;
	timestamp: number;
};

function stringifyValue(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function formatConsoleLocation(message: ConsoleMessage): string | null {
	const location = message.location();
	if (!location.url) {
		return null;
	}
	return `${location.url}:${location.lineNumber ?? 0}:${location.columnNumber ?? 0}`;
}

class BrowserSession {
	private readonly consoleLogs: ConsoleLogEntry[] = [];
	private readonly networkLogs: NetworkLogEntry[] = [];
	private readonly observedPages = new WeakSet<Page>();
	private browser: Browser | null = null;
	private context: BrowserContext | null = null;

	async initialize() {
		if (this.browser && this.context) {
			return;
		}

		await waitForManagedBrowser();
		const connection = await connectToManagedBrowser();
		this.browser = connection.browser;
		this.context = connection.context;

		for (const page of this.context.pages()) {
			this.observePage(page);
		}
		this.context.on("page", (page) => {
			this.observePage(page);
		});
	}

	dispose() {
		this.browser = null;
		this.context = null;
	}

	private getContext(): BrowserContext {
		if (!this.context) {
			throw new Error("Managed browser is not connected");
		}
		return this.context;
	}

	async getPage(): Promise<Page> {
		const context = this.getContext();
		const existingPage = context.pages()[0];
		if (existingPage) {
			return existingPage;
		}
		const page = await context.newPage();
		this.observePage(page);
		return page;
	}

	getConsoleLogs(limit = 50): ConsoleLogEntry[] {
		return this.consoleLogs.slice(-Math.max(1, limit));
	}

	getNetworkLogs(limit = 50): NetworkLogEntry[] {
		return this.networkLogs.slice(-Math.max(1, limit));
	}

	private pushConsoleLog(entry: ConsoleLogEntry) {
		this.consoleLogs.push(entry);
		if (this.consoleLogs.length > MAX_LOG_ENTRIES) {
			this.consoleLogs.splice(0, this.consoleLogs.length - MAX_LOG_ENTRIES);
		}
	}

	private pushNetworkLog(entry: NetworkLogEntry) {
		this.networkLogs.push(entry);
		if (this.networkLogs.length > MAX_LOG_ENTRIES) {
			this.networkLogs.splice(0, this.networkLogs.length - MAX_LOG_ENTRIES);
		}
	}

	private observePage(page: Page) {
		if (this.observedPages.has(page)) {
			return;
		}

		this.observedPages.add(page);

		page.on("console", (message) => {
			this.pushConsoleLog({
				type: message.type(),
				text: message.text(),
				location: formatConsoleLocation(message),
				timestamp: Date.now(),
			});
		});

		page.on("request", (request) => {
			this.pushNetworkLog({
				kind: "request",
				method: request.method(),
				url: request.url(),
				status: null,
				resourceType: request.resourceType(),
				errorText: null,
				timestamp: Date.now(),
			});
		});

		page.on("response", (response: Response) => {
			const request = response.request();
			this.pushNetworkLog({
				kind: "response",
				method: request.method(),
				url: response.url(),
				status: response.status(),
				resourceType: request.resourceType(),
				errorText: null,
				timestamp: Date.now(),
			});
		});

		page.on("requestfailed", (request) => {
			this.pushNetworkLog({
				kind: "request_failed",
				method: request.method(),
				url: request.url(),
				status: null,
				resourceType: request.resourceType(),
				errorText: request.failure()?.errorText ?? null,
				timestamp: Date.now(),
			});
		});
	}
}

export async function runBrowserMcp(): Promise<void> {
	const browserSession = new BrowserSession();
	await browserSession.initialize();

	const server = new McpServer({
		name: "browser",
		version: "1.0.0",
	});

	server.registerTool(
		"open_url",
		{
			description:
				"Navigate the managed Chromium page to a URL. Use desktop tools for visible clicks and typing; use this for direct navigation.",
			inputSchema: {
				url: z.string().url().describe("URL to open in the managed browser"),
			},
		},
		async ({ url }) => {
			const page = await browserSession.getPage();
			await page.goto(url, { waitUntil: "domcontentloaded" });
			return {
				content: [{ type: "text", text: `Opened ${url}` }],
			};
		}
	);

	server.registerTool(
		"get_current_url",
		{
			description: "Return the current URL of the managed Chromium page",
			inputSchema: {},
		},
		async () => {
			const page = await browserSession.getPage();
			return {
				content: [{ type: "text", text: page.url() }],
			};
		}
	);

	server.registerTool(
		"get_dom_snapshot",
		{
			description:
				"Return a compact structural snapshot of the DOM for the current page or a selected subtree",
			inputSchema: {
				selector: z
					.string()
					.optional()
					.describe("Optional CSS selector for the subtree root"),
				maxDepth: z
					.number()
					.int()
					.min(1)
					.max(8)
					.default(4)
					.describe("Maximum DOM depth to serialize"),
			},
		},
		async ({ selector, maxDepth }) => {
			const page = await browserSession.getPage();
			const snapshot = await page.evaluate(
				(input: { selector?: string; maxDepth: number }) => {
					const root = input.selector
						? document.querySelector(input.selector)
						: document.documentElement;

					if (!root) {
						return null;
					}

					const serialize = (element: Element, depth: number): unknown => {
						const normalizedText = (element.textContent || "")
							.replace(/\s+/g, " ")
							.trim()
							.slice(0, 200);

						return {
							tag: element.tagName.toLowerCase(),
							id: element.id || null,
							role: element.getAttribute("role"),
							name:
								element.getAttribute("aria-label") ||
								element.getAttribute("name") ||
								null,
							text: normalizedText || null,
							children:
								depth <= 1
									? []
									: Array.from(element.children)
											.slice(0, 20)
											.map((child) => serialize(child, depth - 1)),
						};
					};

					return {
						url: window.location.href,
						title: document.title,
						root: serialize(root, input.maxDepth),
					};
				},
				{ selector, maxDepth }
			);

			return {
				content: [{ type: "text", text: stringifyValue(snapshot) }],
			};
		}
	);

	server.registerTool(
		"evaluate_javascript",
		{
			description:
				"Evaluate JavaScript in the current page context and return the serialized result",
			inputSchema: {
				expression: z
					.string()
					.min(1)
					.describe("JavaScript expression to evaluate in the page"),
			},
		},
		async ({ expression }) => {
			const page = await browserSession.getPage();
			const result = await page.evaluate(expression);

			return {
				content: [{ type: "text", text: stringifyValue(result) }],
			};
		}
	);

	server.registerTool(
		"wait_for_selector",
		{
			description:
				"Wait for a selector to reach a given state in the current page",
			inputSchema: {
				selector: z.string().min(1).describe("CSS selector to wait for"),
				state: z
					.enum(["attached", "detached", "visible", "hidden"])
					.default("visible")
					.describe("Desired selector state"),
				timeoutMs: z
					.number()
					.int()
					.min(1)
					.max(120_000)
					.default(DEFAULT_WAIT_TIMEOUT_MS)
					.describe("Timeout in milliseconds"),
			},
		},
		async ({ selector, state, timeoutMs }) => {
			const page = await browserSession.getPage();
			await page.waitForSelector(selector, { state, timeout: timeoutMs });
			return {
				content: [
					{
						type: "text",
						text: `Selector ${selector} reached state ${state}`,
					},
				],
			};
		}
	);

	server.registerTool(
		"wait_for_navigation",
		{
			description:
				"Wait for navigation or a target URL pattern on the current page",
			inputSchema: {
				urlPattern: z
					.string()
					.optional()
					.describe("Optional URL glob pattern to wait for"),
				waitUntil: z
					.enum(["load", "domcontentloaded", "networkidle"])
					.default("load")
					.describe("Load state to wait for"),
				timeoutMs: z
					.number()
					.int()
					.min(1)
					.max(120_000)
					.default(DEFAULT_WAIT_TIMEOUT_MS)
					.describe("Timeout in milliseconds"),
			},
		},
		async ({ urlPattern, waitUntil, timeoutMs }) => {
			const page = await browserSession.getPage();
			if (urlPattern) {
				await page.waitForURL(urlPattern, { timeout: timeoutMs, waitUntil });
			} else {
				await page.waitForLoadState(waitUntil, { timeout: timeoutMs });
			}

			return {
				content: [
					{
						type: "text",
						text: `Navigation ready at ${page.url()}`,
					},
				],
			};
		}
	);

	server.registerTool(
		"get_console_logs",
		{
			description:
				"Return recent console messages captured from the managed Chromium page",
			inputSchema: {
				limit: z
					.number()
					.int()
					.min(1)
					.max(MAX_LOG_ENTRIES)
					.default(50)
					.describe("Maximum number of log entries to return"),
			},
		},
		({ limit }) => {
			return {
				content: [
					{
						type: "text",
						text: stringifyValue(browserSession.getConsoleLogs(limit)),
					},
				],
			};
		}
	);

	server.registerTool(
		"get_network_logs",
		{
			description:
				"Return recent request and response events captured from the managed Chromium page",
			inputSchema: {
				limit: z
					.number()
					.int()
					.min(1)
					.max(MAX_LOG_ENTRIES)
					.default(50)
					.describe("Maximum number of network entries to return"),
			},
		},
		({ limit }) => {
			return {
				content: [
					{
						type: "text",
						text: stringifyValue(browserSession.getNetworkLogs(limit)),
					},
				],
			};
		}
	);

	const transport = new StdioServerTransport();
	await server.connect(transport);
}
