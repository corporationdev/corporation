import { Daytona, Image } from "@daytonaio/sdk";
import  { type Connection, Agent, callable } from "agents";
import { SandboxAgent as SandboxAgentClient, type UniversalEvent } from "sandbox-agent";
import { type ServerMessage } from "./agent-types";


const PORT = 3000;
const SNAPSHOT_NAME = "sandbox-agent-ready";
const SERVER_STARTUP_TIMEOUT_MS = 30_000;
const SERVER_POLL_INTERVAL_MS = 500;
const PREVIEW_URL_EXPIRY_SECONDS = 4 * 60 * 60;



type SandboxInfo = {
	sandboxId: string;
	status: "creating" | "ready" | "error";
	createdAt: string;
};

export class SandboxAgent extends Agent<Env> {
	private events: UniversalEvent[] = [];
	private sandboxInfo: SandboxInfo | null = null;
	private sandboxClient: SandboxAgentClient | null = null;
	private sseAbortController: AbortController | null = null;

	async onConnect(connection: Connection) {
		const [storedEvents, storedSandbox] = await Promise.all([
			this.ctx.storage.get<UniversalEvent[]>("events"),
			this.ctx.storage.get<SandboxInfo>("sandbox"),
		]);

		if (storedEvents) {
			this.events = storedEvents;
		}
		if (storedSandbox) {
			this.sandboxInfo = storedSandbox;
		}

		for (const event of this.events) {
			const message: ServerMessage = { type: "event", data: event };
			connection.send(JSON.stringify(message));
		}

		if (this.sandboxInfo?.status === "ready" && !this.sseAbortController) {
			await this.reconnectToSession();
		}
	}

	@callable()
	async sendMessage(content: string) {
		if (this.sandboxInfo?.status === "error") {
			throw new Error("Sandbox is in error state");
		}

		if (!this.sandboxInfo || this.sandboxInfo.status !== "ready") {
			await this.initSandbox();
		}

		if (!this.sandboxClient) {
			throw new Error("Sandbox client not initialized");
		}

		await this.sandboxClient.postMessage(this.sessionId, {
			message: content,
		});
	}

	private get sessionId(): string {
		return this.ctx.id.toString();
	}

	private async initSandbox() {
		this.sandboxInfo = {
			sandboxId: "",
			status: "creating",
			createdAt: new Date().toISOString(),
		};
		await this.ctx.storage.put("sandbox", this.sandboxInfo);

		const daytona = new Daytona({
			apiKey: this.env.DAYTONA_API_KEY,
		});

		await this.ensureSnapshot(daytona);

		const envVars: Record<string, string> = {};
		if (this.env.ANTHROPIC_API_KEY) {
			envVars.ANTHROPIC_API_KEY = this.env.ANTHROPIC_API_KEY;
		}

		const sandbox = await daytona.create({
			snapshot: SNAPSHOT_NAME,
			envVars,
		});

		this.sandboxInfo.sandboxId = sandbox.id;
		await this.ctx.storage.put("sandbox", this.sandboxInfo);

		// Start sandbox-agent server in the background
		await sandbox.process.executeCommand(
			`nohup sandbox-agent server --no-token --host 0.0.0.0 --port ${PORT} >/tmp/sandbox-agent.log 2>&1 &`
		);

		// Wait for server to be ready
		await this.waitForServerReady(sandbox);

		// Get public URL for the sandbox-agent server
		const previewUrl = await sandbox.getSignedPreviewUrl(
			PORT,
			PREVIEW_URL_EXPIRY_SECONDS
		);

		// Connect the sandbox-agent SDK client
		this.sandboxClient = await SandboxAgentClient.connect({
			baseUrl: previewUrl.url,
		});

		// Create a Claude coding session
		await this.sandboxClient.createSession(this.sessionId, {
			agent: "claude",
		});

		this.sandboxInfo.status = "ready";
		await this.ctx.storage.put("sandbox", this.sandboxInfo);

		// Start streaming events from the session
		this.startEventStream();
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

	private async ensureSnapshot(daytona: Daytona) {
		const exists = await daytona.snapshot.get(SNAPSHOT_NAME).then(
			() => true,
			() => false
		);

		if (!exists) {
			await daytona.snapshot.create({
				name: SNAPSHOT_NAME,
				image: Image.base("ubuntu:22.04").runCommands(
					"apt-get update && apt-get install -y curl ca-certificates",
					"curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh",
					"sandbox-agent install-agent claude"
				),
			});
		}
	}

	private async reconnectToSession() {
		if (!this.sandboxInfo || this.sandboxInfo.status !== "ready") {
			return;
		}

		const daytona = new Daytona({
			apiKey: this.env.DAYTONA_API_KEY,
		});

		const sandbox = await daytona.get(this.sandboxInfo.sandboxId);

		const previewUrl = await sandbox.getSignedPreviewUrl(
			PORT,
			PREVIEW_URL_EXPIRY_SECONDS
		);

		this.sandboxClient = await SandboxAgentClient.connect({
			baseUrl: previewUrl.url,
		});

		this.startEventStream();
	}

	private startEventStream() {
		if (!(this.sandboxClient && this.sandboxInfo)) {
			return;
		}
		if (this.sseAbortController) {
			return;
		}

		this.sseAbortController = new AbortController();

		const lastEvent = this.events.at(-1);
		const lastSequence = lastEvent?.sequence ?? 0;
		const client = this.sandboxClient;

		const stream = async () => {
			try {
				for await (const event of client.streamEvents(this.sessionId, {
					offset: lastSequence,
				})) {
					if (this.sseAbortController?.signal.aborted) {
						break;
					}
					await this.storeAndBroadcastEvent(event);
				}
			} catch (error) {
				if (!this.sseAbortController?.signal.aborted) {
					console.error("SSE stream error:", error);
				}
			} finally {
				this.sseAbortController = null;
			}
		};

		stream();
	}

	private async storeAndBroadcastEvent(event: UniversalEvent) {
		this.events.push(event);
		await this.ctx.storage.put("events", this.events);

		const message: ServerMessage = { type: "event", data: event };
		this.broadcast(JSON.stringify(message));
	}
}
