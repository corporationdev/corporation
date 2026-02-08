import { createLogger } from "@corporation/logger";
import { Daytona, Image } from "@daytonaio/sdk";
import { Agent, type Connection, callable } from "agents";
import { SandboxAgent as SandboxAgentClient } from "sandbox-agent";
import type { SandboxInfo, SandboxState } from "./agent-types";

const PORT = 3000;
const SNAPSHOT_NAME = "sandbox-agent-ready";
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const SERVER_POLL_INTERVAL_MS = 500;
const PREVIEW_URL_EXPIRY_SECONDS = 4 * 60 * 60;

const log = createLogger("sandbox-agent");

export class SandboxAgent extends Agent<Env, SandboxState> {
	initialState: SandboxState = {
		sandbox: null,
		previewUrl: null,
		events: [],
	};

	private readonly daytona = new Daytona({ apiKey: this.env.DAYTONA_API_KEY });
	private sandboxClient: SandboxAgentClient | null = null;
	private sseAbortController: AbortController | null = null;

	async onConnect(_connection: Connection) {
		if (this.state.sandbox?.status === "ready" && !this.sseAbortController) {
			await this.reconnectToSession();
		}
	}

	@callable()
	async replyPermission(
		permissionId: string,
		reply: "once" | "always" | "reject"
	) {
		if (!this.sandboxClient) {
			throw new Error("Sandbox client not initialized");
		}
		await this.sandboxClient.replyPermission(this.sessionId, permissionId, {
			reply,
		});
		log.info(
			{ sessionId: this.sessionId, permissionId, reply },
			"permission reply sent"
		);
	}

	@callable()
	async sendMessage(content: string) {
		const startTime = Date.now();
		const needsInit =
			!this.state.sandbox || this.state.sandbox.status !== "ready";

		if (this.state.sandbox?.status === "error") {
			throw new Error("Sandbox is in error state");
		}

		if (needsInit) {
			await this.initSandbox();
		}

		if (!this.sandboxClient) {
			throw new Error("Sandbox client not initialized");
		}

		await this.sandboxClient.postMessage(this.sessionId, {
			message: content,
		});

		log.info(
			{
				sessionId: this.sessionId,
				sandboxId: this.state.sandbox?.sandboxId,
				needsInit,
				durationMs: Date.now() - startTime,
			},
			"message sent"
		);
	}

	private get sessionId(): string {
		return this.ctx.id.toString();
	}

	private initPromise: Promise<void> | null = null;

	private initSandbox() {
		this.initPromise ??= this.doInitSandbox().finally(() => {
			this.initPromise = null;
		});
		return this.initPromise;
	}

	private async doInitSandbox() {
		const startTime = Date.now();
		const info: SandboxInfo = {
			sandboxId: "",
			status: "creating",
			createdAt: new Date().toISOString(),
		};
		this.setState({ ...this.state, sandbox: info });

		try {
			await this.ensureSnapshot();

			const envVars: Record<string, string> = {
				ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
			};

			const sandbox = await this.daytona.create({
				snapshot: SNAPSHOT_NAME,
				envVars,
			});

			info.sandboxId = sandbox.id;
			this.setState({ ...this.state, sandbox: info });
			log.debug(
				{ sandboxId: sandbox.id, sessionId: this.sessionId },
				"sandbox created"
			);

			await sandbox.process.executeCommand(
				`nohup sandbox-agent server --no-token --host 0.0.0.0 --port ${PORT} >/tmp/sandbox-agent.log 2>&1 &`
			);

			await this.waitForServerReady(sandbox);
			log.debug({ sandboxId: sandbox.id }, "sandbox server ready");

			const previewUrl = await sandbox.getSignedPreviewUrl(
				PORT,
				PREVIEW_URL_EXPIRY_SECONDS
			);

			this.sandboxClient = await SandboxAgentClient.connect({
				baseUrl: previewUrl.url,
			});

			await this.sandboxClient.createSession(this.sessionId, {
				agent: "claude",
			});

			info.status = "ready";
			this.setState({
				...this.state,
				sandbox: info,
				previewUrl: previewUrl.url,
			});

			log.info(
				{
					sessionId: this.sessionId,
					sandboxId: sandbox.id,
					durationMs: Date.now() - startTime,
				},
				"sandbox initialized"
			);

			this.startEventStream();
		} catch (error) {
			info.status = "error";
			this.setState({ ...this.state, sandbox: info });
			log.error(
				{
					sessionId: this.sessionId,
					sandboxId: info.sandboxId || undefined,
					durationMs: Date.now() - startTime,
					err: error,
				},
				"sandbox init failed"
			);
			throw error;
		}
	}

	private async waitForServerReady(
		sandbox: Awaited<ReturnType<Daytona["create"]>>
	) {
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

	private async ensureSnapshot() {
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

	private async reconnectToSession() {
		const { sandbox } = this.state;
		if (!sandbox || sandbox.status !== "ready") {
			return;
		}

		log.debug(
			{ sessionId: this.sessionId, sandboxId: sandbox.sandboxId },
			"reconnecting"
		);

		try {
			const daySandbox = await this.daytona.get(sandbox.sandboxId);
			await daySandbox.refreshData();

			if (daySandbox.state !== "started") {
				log.info(
					{
						sessionId: this.sessionId,
						sandboxId: sandbox.sandboxId,
						sandboxState: daySandbox.state,
					},
					"sandbox no longer running, re-initializing"
				);
				this.setState({
					...this.state,
					sandbox: null,
					previewUrl: null,
				});
				await this.initSandbox();
				return;
			}

			const previewUrl = await daySandbox.getSignedPreviewUrl(
				PORT,
				PREVIEW_URL_EXPIRY_SECONDS
			);

			this.sandboxClient = await SandboxAgentClient.connect({
				baseUrl: previewUrl.url,
			});

			this.setState({ ...this.state, previewUrl: previewUrl.url });
			this.startEventStream();
		} catch (error) {
			log.error(
				{ sessionId: this.sessionId, sandboxId: sandbox.sandboxId, err: error },
				"reconnect failed"
			);
			this.setState({
				...this.state,
				sandbox: { ...sandbox, status: "error" },
			});
		}
	}

	private startEventStream() {
		if (!(this.sandboxClient && this.state.sandbox)) {
			return;
		}
		if (this.sseAbortController) {
			return;
		}

		this.sseAbortController = new AbortController();

		const lastEvent = this.state.events.at(-1);
		const lastSequence = lastEvent?.sequence ?? 0;
		const client = this.sandboxClient;

		log.debug(
			{ sessionId: this.sessionId, offset: lastSequence },
			"sse stream starting"
		);

		const stream = async () => {
			try {
				for await (const event of client.streamEvents(this.sessionId, {
					offset: lastSequence,
				})) {
					if (this.sseAbortController?.signal.aborted) {
						break;
					}
					this.setState({
						...this.state,
						events: [...this.state.events, event],
					});
				}
			} catch (error) {
				if (!this.sseAbortController?.signal.aborted) {
					log.error(
						{ sessionId: this.sessionId, offset: lastSequence, err: error },
						"sse stream error"
					);
				}
			} finally {
				this.sseAbortController = null;
			}
		};

		stream();
	}
}
