import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type {
	SessionRow,
	SessionStreamState,
} from "@corporation/contracts/browser-do";
import {
	sessionRowSchema,
	sessionStreamStateSchema,
} from "@corporation/contracts/browser-do";
import type { browserSpaceContract } from "@corporation/contracts/orpc/browser-space";
import { runtimeControlContract } from "@corporation/contracts/orpc/runtime-control";
import type { runtimeIngressContract } from "@corporation/contracts/orpc/runtime-ingress";
import type { workerHttpContract } from "@corporation/contracts/orpc/worker-http";
import {
	mintRuntimeRefreshToken,
	type RuntimeAuthSessionResponse,
} from "@corporation/contracts/runtime-auth";
import type {
	RuntimeCancelTurnMessage,
	RuntimeProbeAgentsMessage,
	RuntimeProbeResultMessage,
	RuntimeSessionEventBatchMessage,
	RuntimeStartTurnMessage,
	RuntimeTurnCompletedMessage,
	RuntimeTurnFailedMessage,
} from "@corporation/contracts/sandbox-do";
import { createORPCClient } from "@orpc/client";
import { RPCLink as FetchRPCLink } from "@orpc/client/fetch";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/websocket";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const SERVER_APP_DIR = resolve(REPO_ROOT, "apps/server");
const WORKER_HEALTH_PATH = "/api/health";
function resolveWranglerCliPath(): string {
	const bunStoreDir = resolve(REPO_ROOT, "node_modules/.bun");
	const wranglerDir = readdirSync(bunStoreDir).find((entry) =>
		entry.startsWith("wrangler@")
	);
	if (!wranglerDir) {
		throw new Error("Could not locate wrangler in node_modules/.bun");
	}
	return resolve(
		bunStoreDir,
		wranglerDir,
		"node_modules/wrangler/wrangler-dist/cli.js"
	);
}

const WRANGLER_CLI_PATH = resolveWranglerCliPath();

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
};
type SocketListener = Parameters<WebSocket["addEventListener"]>[1];
type SocketListenerOptions = Parameters<WebSocket["addEventListener"]>[2];
type ORPCFrameDirection = "request" | "response";

type RuntimeCommand =
	| RuntimeStartTurnMessage
	| RuntimeCancelTurnMessage
	| RuntimeProbeAgentsMessage;

type RuntimeCommandType = RuntimeCommand["type"];

type BrowserClient = ContractRouterClient<typeof browserSpaceContract>;
type RuntimeIngressClient = ContractRouterClient<typeof runtimeIngressContract>;
type WorkerHttpClient = ContractRouterClient<typeof workerHttpContract>;

type BrowserSocketClient = {
	socket: WebSocket;
	client: BrowserClient;
	close: () => void;
};

type LocalWorker = {
	baseUrl: string;
	stop: () => Promise<void>;
};

type JwksServer = {
	baseUrl: string;
	mintBrowserToken: (input?: {
		sub?: string;
		email?: string;
		name?: string;
		sessionId?: string;
	}) => Promise<string>;
	stop: () => Promise<void>;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((nextResolve, nextReject) => {
		resolve = nextResolve;
		reject = nextReject;
	});
	return { promise, resolve, reject };
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getORPCFrameDirection(
	data: string | ArrayBufferLike | ArrayBufferView<ArrayBufferLike>
): ORPCFrameDirection | null {
	try {
		const bytes =
			typeof data === "string"
				? null
				: ArrayBuffer.isView(data)
					? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
					: new Uint8Array(data);
		const text =
			typeof data === "string" ? data : new TextDecoder().decode(bytes);
		const parsed = JSON.parse(text) as {
			p?: { u?: unknown };
		};
		return typeof parsed.p?.u === "string" ? "request" : "response";
	} catch {
		return null;
	}
}

class TestWebSocketPeer {
	private readonly listeners = new Map<string, Set<SocketListener>>();
	private readonly direction: ORPCFrameDirection;
	private readonly socket: WebSocket;

	constructor(socket: WebSocket, direction: ORPCFrameDirection) {
		this.socket = socket;
		this.direction = direction;
		socket.addEventListener("open", (event) => this.emit("open", event));
		socket.addEventListener("close", (event) => this.emit("close", event));
		socket.addEventListener("error", (event) => this.emit("error", event));
		socket.addEventListener("message", (event) => {
			if (getORPCFrameDirection(event.data) !== this.direction) {
				return;
			}
			this.emit("message", event);
		});
	}

	addEventListener(
		type: string,
		listener: SocketListener,
		_options?: SocketListenerOptions
	) {
		if (!listener) {
			return;
		}
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	get readyState() {
		return this.socket.readyState;
	}

	send(data: string | ArrayBufferLike | ArrayBufferView<ArrayBufferLike>) {
		this.socket.send(
			data as string | ArrayBufferLike | Bun.ArrayBufferView<ArrayBufferLike>
		);
	}

	private emit(
		type: string,
		event:
			| {
					data?: string | ArrayBufferLike | ArrayBufferView<ArrayBufferLike>;
			  }
			| Event
	) {
		for (const listener of this.listeners.get(type) ?? []) {
			if (typeof listener === "function") {
				listener(event as Event);
				continue;
			}
			listener.handleEvent(event as Event);
		}
	}
}

async function eventually<T>(
	read: () => Promise<T>,
	predicate: (value: T) => boolean,
	label: string,
	timeoutMs = 15_000,
	intervalMs = 100
): Promise<T> {
	const startedAt = Date.now();
	let lastValue: T | undefined;

	while (Date.now() - startedAt < timeoutMs) {
		lastValue = await read();
		if (predicate(lastValue)) {
			return lastValue;
		}
		await sleep(intervalMs);
	}

	throw new Error(
		`${label} timed out after ${timeoutMs}ms${
			lastValue === undefined
				? ""
				: ` (last value: ${JSON.stringify(lastValue)})`
		}`
	);
}

async function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.OPEN) {
		return;
	}

	await new Promise<void>((resolve, reject) => {
		const onOpen = () => {
			cleanup();
			resolve();
		};
		const onError = (event: Event) => {
			cleanup();
			reject(new Error(`WebSocket failed to open: ${String(event.type)}`));
		};
		const cleanup = () => {
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
		};

		socket.addEventListener("open", onOpen, { once: true });
		socket.addEventListener("error", onError, { once: true });
	});
}

async function startJwksServer(): Promise<JwksServer> {
	const { publicKey, privateKey } = await generateKeyPair("RS256");
	const publicJwk = await exportJWK(publicKey);
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/api/auth/convex/jwks") {
				return Response.json({
					keys: [
						{
							...publicJwk,
							alg: "RS256",
							use: "sig",
							kid: "test-key",
						},
					],
				});
			}
			return new Response("Not found", { status: 404 });
		},
	});

	return {
		baseUrl: `http://127.0.0.1:${server.port}`,
		mintBrowserToken: async (input) =>
			await new SignJWT({
				sub: input?.sub ?? "user-test",
				email: input?.email ?? "test@example.com",
				name: input?.name ?? "Test User",
				sessionId: input?.sessionId ?? "session-test",
			})
				.setProtectedHeader({ alg: "RS256", kid: "test-key" })
				.setIssuedAt()
				.setExpirationTime("15m")
				.sign(privateKey),
		stop: () => {
			server.stop(true);
			return Promise.resolve();
		},
	};
}

async function startLocalWorker(options: {
	convexSiteUrl: string;
	runtimeAuthSecret: string;
}): Promise<LocalWorker> {
	const tempRoot = resolve(SERVER_APP_DIR, ".test-tmp");
	await mkdir(tempRoot, { recursive: true });
	const tempDir = await mkdtemp(resolve(tempRoot, "server-runtime-do-test-"));
	const configPath = resolve(tempDir, "wrangler.jsonc");
	const port = await new Promise<number>((resolvePort, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Failed to allocate local worker port"));
				return;
			}
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolvePort(address.port);
			});
		});
		server.on("error", reject);
	});

	const config = {
		name: `server-runtime-do-test-${Date.now()}`,
		main: resolve(SERVER_APP_DIR, "src/index.ts"),
		compatibility_date: "2026-03-11",
		compatibility_flags: ["nodejs_compat"],
		durable_objects: {
			bindings: [
				{
					name: "SPACE_DO",
					class_name: "SpaceDurableObject",
				},
			],
		},
		migrations: [
			{
				tag: "v1",
				new_sqlite_classes: ["SpaceDurableObject"],
			},
		],
		vars: {
			CORPORATION_CONVEX_SITE_URL: options.convexSiteUrl,
			CORPORATION_RUNTIME_AUTH_SECRET: options.runtimeAuthSecret,
			CORPORATION_INTERNAL_API_KEY: "test-internal-api-key",
			NANGO_SECRET_KEY: "test-nango-secret",
			ANTHROPIC_API_KEY: "",
			E2B_API_KEY: "",
		},
	};

	await writeFile(configPath, JSON.stringify(config, null, 2));

	const worker = Bun.spawn(
		[
			"node",
			WRANGLER_CLI_PATH,
			"dev",
			"--config",
			configPath,
			"--port",
			String(port),
			"--ip",
			"127.0.0.1",
			"--local-protocol",
			"http",
		],
		{
			cwd: SERVER_APP_DIR,
			env: {
				...process.env,
				NO_COLOR: "1",
				BROWSER: "none",
				CI: "1",
			},
			stdout: "pipe",
			stderr: "pipe",
		}
	);

	const baseUrl = `http://127.0.0.1:${port}`;
	const stdoutPromise = new Response(worker.stdout).text();
	const stderrPromise = new Response(worker.stderr).text();

	try {
		await eventually(
			async () => {
				try {
					const response = await fetch(`${baseUrl}${WORKER_HEALTH_PATH}`);
					return response.status;
				} catch {
					return 0;
				}
			},
			(status) => status > 0,
			"local worker health",
			10_000
		);
	} catch (error) {
		worker.kill();
		throw new Error(
			[
				error instanceof Error ? error.message : String(error),
				"wrangler stdout:",
				await stdoutPromise,
				"wrangler stderr:",
				await stderrPromise,
			]
				.filter(Boolean)
				.join("\n\n")
		);
	}

	return {
		baseUrl,
		stop: async () => {
			worker.kill();
			if (existsSync(tempDir)) {
				await rm(tempDir, { recursive: true, force: true });
			}
		},
	};
}

function createWorkerHttpClient(baseUrl: string): WorkerHttpClient {
	return createORPCClient<WorkerHttpClient>(
		new FetchRPCLink({
			url: new URL("/api/rpc", baseUrl).toString(),
		})
	);
}

export async function createBrowserSocketClient(input: {
	baseUrl: string;
	spaceSlug: string;
	token: string;
}): Promise<BrowserSocketClient> {
	const websocketUrl = new URL(
		`/api/spaces/${encodeURIComponent(input.spaceSlug)}/socket`,
		input.baseUrl
	);
	websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
	websocketUrl.search = new URLSearchParams({ token: input.token }).toString();

	const socket = new WebSocket(websocketUrl);
	await waitForWebSocketOpen(socket);
	const client = createORPCClient<BrowserClient>(
		new WebSocketRPCLink({
			websocket: socket,
		})
	);

	return {
		socket,
		client,
		close: () => {
			if (socket.readyState === WebSocket.OPEN) {
				socket.close();
			}
		},
	};
}

export class FakeRuntimeSocket {
	private readonly onCommandByType = new Map<
		RuntimeCommandType,
		Array<(command: RuntimeCommand) => void>
	>();
	private handler: RPCHandler<object> | null = null;
	private ingressClient: RuntimeIngressClient | null = null;
	private socket: WebSocket | null = null;
	private readonly receivedCommands: RuntimeCommand[] = [];

	async connect(input: {
		baseUrl: string;
		spaceSlug: string;
		sandboxId: string;
		userId?: string;
		runtimeAuthSecret: string;
	}) {
		const refreshToken = await mintRuntimeRefreshToken(
			{
				sub: input.userId ?? "runtime-user",
				spaceSlug: input.spaceSlug,
				sandboxId: input.sandboxId,
				exp: Math.floor(Date.now() / 1000) + 3600,
			},
			input.runtimeAuthSecret
		);
		const workerHttp = createWorkerHttpClient(input.baseUrl);
		const session = (await workerHttp.runtimeAuth.createSession({
			spaceSlug: input.spaceSlug,
			refreshToken,
		})) as RuntimeAuthSessionResponse;

		const socket = new WebSocket(session.websocketUrl);
		await waitForWebSocketOpen(socket);
		const ingressPeer = new TestWebSocketPeer(socket, "response");
		const controlPeer = new TestWebSocketPeer(socket, "request");

		const implementer = implement(runtimeControlContract);
		const router = implementer.router({
			startTurn: implementer.startTurn.handler(({ input: command }) => {
				this.recordCommand(command);
				return null;
			}),
			cancelTurn: implementer.cancelTurn.handler(({ input: command }) => {
				this.recordCommand(command);
				return null;
			}),
			probeAgents: implementer.probeAgents.handler(({ input: command }) => {
				this.recordCommand(command);
				return null;
			}),
		});

		const handler = new RPCHandler(router);
		handler.upgrade(controlPeer);

		this.handler = handler;
		this.socket = socket;
		this.ingressClient = createORPCClient<RuntimeIngressClient>(
			new WebSocketRPCLink({
				websocket: ingressPeer,
			})
		);

		await this.ingressClient.register({
			spaceSlug: input.spaceSlug,
			sandboxId: input.sandboxId,
			clientType: "sandbox_runtime",
			protocolVersion: 1,
			capabilities: {
				sessionEventBatching: true,
				turnCancellation: true,
				agentProbing: true,
			},
		});
	}

	private recordCommand(command: RuntimeCommand) {
		this.receivedCommands.push(command);
		const waiters = this.onCommandByType.get(command.type) ?? [];
		const waiter = waiters.shift();
		if (waiter) {
			waiter(command);
		}
		this.onCommandByType.set(command.type, waiters);
	}

	waitForCommand<T extends RuntimeCommandType>(type: T, timeoutMs = 10_000) {
		const existing = this.receivedCommands.find(
			(command): command is Extract<RuntimeCommand, { type: T }> =>
				command.type === type
		);
		if (existing) {
			return Promise.resolve(existing);
		}

		const next = deferred<Extract<RuntimeCommand, { type: T }>>();
		const waiters = this.onCommandByType.get(type) ?? [];
		waiters.push((command) => {
			next.resolve(command as Extract<RuntimeCommand, { type: T }>);
		});
		this.onCommandByType.set(type, waiters);

		return Promise.race([
			next.promise,
			sleep(timeoutMs).then(() => {
				throw new Error(`Timed out waiting for runtime command ${type}`);
			}),
		]);
	}

	async pushSessionEventBatch(message: RuntimeSessionEventBatchMessage) {
		if (!this.ingressClient) {
			throw new Error("Runtime ingress client not connected");
		}
		await this.ingressClient.pushSessionEventBatch(message);
	}

	async completeTurn(message: RuntimeTurnCompletedMessage) {
		if (!this.ingressClient) {
			throw new Error("Runtime ingress client not connected");
		}
		await this.ingressClient.completeTurn(message);
	}

	async failTurn(message: RuntimeTurnFailedMessage) {
		if (!this.ingressClient) {
			throw new Error("Runtime ingress client not connected");
		}
		await this.ingressClient.failTurn(message);
	}

	async sendProbeResult(message: RuntimeProbeResultMessage) {
		if (!this.ingressClient) {
			throw new Error("Runtime ingress client not connected");
		}
		await this.ingressClient.probeResult(message);
	}

	close(reason?: string) {
		this.handler = null;
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.socket.close(1000, reason);
		}
		this.socket = null;
		this.ingressClient = null;
	}
}

export async function createHarness() {
	const runtimeAuthSecret = `test-runtime-secret-${crypto.randomUUID()}`;
	const jwksServer = await startJwksServer();
	const worker = await startLocalWorker({
		convexSiteUrl: jwksServer.baseUrl,
		runtimeAuthSecret,
	});

	const getSessionState = async (
		spaceSlug: string,
		sessionId: string
	): Promise<SessionStreamState> => {
		const token = await jwksServer.mintBrowserToken();
		const response = await fetch(
			`${worker.baseUrl}/api/spaces/${encodeURIComponent(spaceSlug)}/sessions/${encodeURIComponent(sessionId)}/state`,
			{
				headers: {
					Authorization: `Bearer ${token}`,
				},
			}
		);
		if (!response.ok) {
			throw new Error(
				`Failed to get session state: ${response.status} ${await response.text()}`
			);
		}
		return sessionStreamStateSchema.parse(await response.json());
	};

	const cleanup = async () => {
		await worker.stop();
		await jwksServer.stop();
	};

	return {
		baseUrl: worker.baseUrl,
		runtimeAuthSecret,
		mintBrowserToken: jwksServer.mintBrowserToken,
		createBrowserClient: async (spaceSlug: string) =>
			await createBrowserSocketClient({
				baseUrl: worker.baseUrl,
				spaceSlug,
				token: await jwksServer.mintBrowserToken(),
			}),
		createRuntime: async (spaceSlug: string, sandboxId: string) => {
			const runtime = new FakeRuntimeSocket();
			await runtime.connect({
				baseUrl: worker.baseUrl,
				spaceSlug,
				sandboxId,
				runtimeAuthSecret,
			});
			return runtime;
		},
		getSessionState,
		listSessions: async (browser: BrowserSocketClient): Promise<SessionRow[]> =>
			sessionRowSchema.array().parse(await browser.client.listSessions()),
		waitForSessionState: async (
			spaceSlug: string,
			sessionId: string,
			predicate: (state: SessionStreamState) => boolean,
			label: string
		) =>
			await eventually(
				() => getSessionState(spaceSlug, sessionId),
				predicate,
				label
			),
		cleanup,
	};
}

export async function startRealRuntimeProcess(input: {
	baseUrl: string;
	spaceSlug: string;
	sandboxId: string;
	runtimeAuthSecret: string;
	stateDir?: string;
}) {
	const refreshToken = await mintRuntimeRefreshToken(
		{
			sub: "runtime-user",
			spaceSlug: input.spaceSlug,
			sandboxId: input.sandboxId,
			exp: Math.floor(Date.now() / 1000) + 3600,
		},
		input.runtimeAuthSecret
	);
	const runtimeStateDir =
		input.stateDir ??
		(await mkdtemp(resolve(tmpdir(), "sandbox-runtime-state-")));
	await mkdir(runtimeStateDir, { recursive: true });

	const runtimeProcess = Bun.spawn(
		["bun", "src/index.ts", "--host", "127.0.0.1", "--port", "5799"],
		{
			cwd: resolve(REPO_ROOT, "apps/sandbox-runtime"),
			env: {
				...process.env,
				CORPORATION_SERVER_URL: input.baseUrl,
				CORPORATION_SPACE_SLUG: input.spaceSlug,
				CORPORATION_RUNTIME_REFRESH_TOKEN: refreshToken,
				CORPORATION_SANDBOX_ID: input.sandboxId,
				CORPORATION_RUNTIME_STATE_DIR: runtimeStateDir,
			},
			stdout: "pipe",
			stderr: "pipe",
		}
	);

	await eventually(
		async () => {
			try {
				const response = await fetch("http://127.0.0.1:5799/health");
				return response.status;
			} catch {
				return 0;
			}
		},
		(status) => status === 200,
		"real runtime process health"
	);

	return {
		stop: async () => {
			runtimeProcess.kill();
			if (existsSync(runtimeStateDir)) {
				await rm(runtimeStateDir, { recursive: true, force: true });
			}
		},
	};
}

export { eventually };
