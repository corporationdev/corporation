import { createLogger } from "@corporation/logger";
import { Daytona, Image, type Sandbox } from "@daytonaio/sdk";
import { Agent, callable } from "agents";
import {
	SandboxAgent as SandboxAgentClient,
	SandboxAgentError,
} from "sandbox-agent";
import type { SandboxInfo, SandboxState } from "./agent-types";

const PORT = 3000;
const SNAPSHOT_NAME = "sandbox-agent-ready";
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const SERVER_POLL_INTERVAL_MS = 500;
const SANDBOX_START_TIMEOUT = 120;

const log = createLogger("sandbox-agent");

export class SandboxAgent extends Agent<Env, SandboxState> {
	initialState: SandboxState = {
		sandbox: null,
		events: [],
	};

	private readonly daytona = new Daytona({ apiKey: this.env.DAYTONA_API_KEY });
	private sandboxClient: SandboxAgentClient | null = null;
	private sseAbortController: AbortController | null = null;
	private ensureReadyPromise: Promise<SandboxAgentClient> | null = null;

	private get isStreaming(): boolean {
		return (
			this.sseAbortController !== null &&
			!this.sseAbortController.signal.aborted
		);
	}

	private get sessionId(): string {
		return this.ctx.id.toString();
	}

	// ---------------------------------------------------------------------------
	// Callable RPC methods
	// ---------------------------------------------------------------------------

	@callable()
	async sendMessage(content: string) {
		const startTime = Date.now();
		const client = await this.ensureSandboxReady();

		await client.postMessage(this.sessionId, {
			message: content,
		});

		log.info(
			{
				sessionId: this.sessionId,
				sandboxId: this.state.sandbox?.sandboxId,
				durationMs: Date.now() - startTime,
			},
			"message sent"
		);
	}

	@callable()
	async replyPermission(
		permissionId: string,
		reply: "once" | "always" | "reject"
	) {
		const client = await this.ensureSandboxReady();

		await client.replyPermission(this.sessionId, permissionId, {
			reply,
		});
		log.info(
			{ sessionId: this.sessionId, permissionId, reply },
			"permission reply sent"
		);
	}

	// ---------------------------------------------------------------------------
	// Core lifecycle: ensureSandboxReady
	// ---------------------------------------------------------------------------

	private ensureSandboxReady(): Promise<SandboxAgentClient> {
		this.ensureReadyPromise ??= this.doEnsureSandboxReady().finally(() => {
			this.ensureReadyPromise = null;
		});
		return this.ensureReadyPromise;
	}

	private async doEnsureSandboxReady(): Promise<SandboxAgentClient> {
		const sandbox = this.state.sandbox;

		// Already fully ready and streaming
		if (this.isStreaming && this.sandboxClient) {
			return this.sandboxClient;
		}

		// No sandbox ever created
		if (!sandbox) {
			return this.createSandboxFromScratch();
		}

		// Sandbox in error state — clean up and start fresh
		if (sandbox.status === "error") {
			log.info(
				{ sandboxId: sandbox.sandboxId },
				"sandbox in error, recreating"
			);
			await this.cleanupSandbox(sandbox.sandboxId);
			return this.createSandboxFromScratch();
		}

		// Sandbox exists but not connected — check Daytona state and recover
		const daySandbox = await this.daytona.get(sandbox.sandboxId);
		await daySandbox.refreshData();
		const daytonaState = daySandbox.state;

		if (
			daytonaState === "destroyed" ||
			daytonaState === "destroying" ||
			daytonaState === "error" ||
			daytonaState === "build_failed"
		) {
			log.info(
				{ sandboxId: sandbox.sandboxId, daytonaState },
				"sandbox gone, creating fresh"
			);
			await this.cleanupSandbox(sandbox.sandboxId);
			return this.createSandboxFromScratch();
		}

		if (daytonaState === "stopped" || daytonaState === "archived") {
			return this.wakeSandbox(sandbox);
		}

		if (daytonaState !== "started") {
			await daySandbox.waitUntilStarted(SANDBOX_START_TIMEOUT);
		}

		return this.connectAndStream(daySandbox, sandbox);
	}

	// ---------------------------------------------------------------------------
	// Lifecycle paths
	// ---------------------------------------------------------------------------

	private async createSandboxFromScratch(): Promise<SandboxAgentClient> {
		const startTime = Date.now();
		const info: SandboxInfo = {
			sandboxId: "",
			status: "creating",
			createdAt: new Date().toISOString(),
		};
		this.updateSandboxInfo(info);

		try {
			await this.ensureSnapshot();

			const sandbox = await this.daytona.create({
				snapshot: SNAPSHOT_NAME,
				envVars: { ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY },
			});

			info.sandboxId = sandbox.id;
			this.updateSandboxInfo(info);
			log.debug({ sandboxId: sandbox.id }, "sandbox created");

			await this.bootSandboxAgent(sandbox);
			const client = await this.connectAndStream(sandbox, info);

			log.info(
				{
					sessionId: this.sessionId,
					sandboxId: sandbox.id,
					durationMs: Date.now() - startTime,
				},
				"sandbox created and ready"
			);

			return client;
		} catch (error) {
			info.status = "error";
			info.errorMessage =
				error instanceof Error ? error.message : String(error);
			this.updateSandboxInfo(info);
			log.error(
				{ err: error, sandboxId: info.sandboxId || undefined },
				"sandbox creation failed"
			);
			throw error;
		}
	}

	private async wakeSandbox(info: SandboxInfo): Promise<SandboxAgentClient> {
		const startTime = Date.now();
		const sandbox = await this.daytona.get(info.sandboxId);
		await sandbox.start(SANDBOX_START_TIMEOUT);
		log.debug({ sandboxId: info.sandboxId }, "sandbox started");

		// Sandbox-agent process dies when sandbox stops — re-boot it
		await this.bootSandboxAgent(sandbox);
		const client = await this.connectAndStream(sandbox, info);

		log.info(
			{
				sessionId: this.sessionId,
				sandboxId: info.sandboxId,
				durationMs: Date.now() - startTime,
			},
			"sandbox woken and ready"
		);

		return client;
	}

	// ---------------------------------------------------------------------------
	// Shared helpers
	// ---------------------------------------------------------------------------

	private async connectAndStream(
		sandbox: Sandbox,
		info: SandboxInfo
	): Promise<SandboxAgentClient> {
		const previewUrl = await sandbox.getSignedPreviewUrl(PORT);

		this.sandboxClient = await SandboxAgentClient.connect({
			baseUrl: previewUrl.url,
		});

		// Create session — catch 409 if it already exists (reconnect case)
		try {
			await this.sandboxClient.createSession(this.sessionId, {
				agent: "claude",
			});
		} catch (error) {
			if (error instanceof SandboxAgentError && error.status === 409) {
				log.debug(
					{ sessionId: this.sessionId },
					"session already exists, reusing"
				);
			} else {
				throw error;
			}
		}

		this.setState({
			...this.state,
			sandbox: {
				...info,
				status: "ready",
				previewUrl: previewUrl.url,
			},
		});

		this.startEventStream(this.sandboxClient);

		return this.sandboxClient;
	}

	private async bootSandboxAgent(sandbox: Sandbox): Promise<void> {
		await sandbox.process.executeCommand(
			`nohup sandbox-agent server --no-token --host 0.0.0.0 --port ${PORT} >/tmp/sandbox-agent.log 2>&1 &`
		);
		await this.waitForServerReady(sandbox);
		log.debug({ sandboxId: sandbox.id }, "sandbox-agent server ready");
	}

	private startEventStream(client: SandboxAgentClient): void {
		// Abort any existing stream before starting a new one
		this.stopStreaming();

		this.sseAbortController = new AbortController();
		const { signal } = this.sseAbortController;

		const lastEvent = this.state.events.at(-1);
		const lastSequence = lastEvent?.sequence ?? 0;

		log.debug(
			{ sessionId: this.sessionId, offset: lastSequence },
			"sse stream starting"
		);

		const stream = async () => {
			try {
				for await (const event of client.streamEvents(
					this.sessionId,
					{ offset: lastSequence },
					signal
				)) {
					if (signal.aborted) {
						break;
					}
					this.setState({
						...this.state,
						events: [...this.state.events, event],
					});
				}
				log.debug({ sessionId: this.sessionId }, "sse stream ended normally");
			} catch (error) {
				if (!signal.aborted) {
					log.error(
						{ sessionId: this.sessionId, err: error },
						"sse stream error"
					);
				}
			} finally {
				// Clean up — next sendMessage will detect !isStreaming and reconnect
				if (this.sseAbortController?.signal === signal) {
					this.sseAbortController = null;
				}
			}
		};

		stream();
	}

	private async waitForServerReady(sandbox: Sandbox): Promise<void> {
		const deadline = Date.now() + SERVER_STARTUP_TIMEOUT_MS;

		while (Date.now() < deadline) {
			try {
				const result = await sandbox.process.executeCommand(
					`curl -sf http://localhost:${PORT}/v1/health`
				);
				if (result.exitCode === 0) {
					return;
				}
			} catch {
				// Server not ready yet
			}
			await new Promise((resolve) =>
				setTimeout(resolve, SERVER_POLL_INTERVAL_MS)
			);
		}

		throw new Error("sandbox-agent server failed to start within timeout");
	}

	private async ensureSnapshot(): Promise<void> {
		let exists = true;
		try {
			await this.daytona.snapshot.get(SNAPSHOT_NAME);
		} catch {
			exists = false;
		}

		if (!exists) {
			log.info("creating snapshot, this may take a while");
			await this.daytona.snapshot.create({
				name: SNAPSHOT_NAME,
				image: Image.base("ubuntu:22.04").runCommands(
					"apt-get update && apt-get install -y curl ca-certificates",
					"curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh",
					"sandbox-agent install-agent claude"
				),
			});
			log.info("snapshot created");
		}
	}

	// ---------------------------------------------------------------------------
	// State management helpers
	// ---------------------------------------------------------------------------

	private updateSandboxInfo(info: SandboxInfo): void {
		this.setState({ ...this.state, sandbox: info });
	}

	private resetState(): void {
		this.stopStreaming();
		this.sandboxClient = null;
		this.setState({ sandbox: null, events: [] });
	}

	private stopStreaming(): void {
		if (this.sseAbortController) {
			this.sseAbortController.abort();
			this.sseAbortController = null;
		}
	}

	private async cleanupSandbox(sandboxId: string): Promise<void> {
		this.stopStreaming();
		this.sandboxClient = null;
		if (sandboxId) {
			try {
				const sandbox = await this.daytona.get(sandboxId);
				await sandbox.delete(30);
			} catch (error) {
				log.warn(
					{ err: error, sandboxId },
					"cleanup delete failed (may already be gone)"
				);
			}
		}
		this.resetState();
	}
}
