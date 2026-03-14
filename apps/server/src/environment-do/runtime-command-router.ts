import type {
	EnvironmentRpcError,
	EnvironmentRpcResult,
} from "@corporation/contracts/environment-do";
import type {
	EnvironmentRuntimeCommand,
	EnvironmentRuntimeCommandResponse,
} from "@corporation/contracts/environment-runtime";
import type { RuntimeSocketAttachment } from "./types";
import { errorResult, okResult } from "./types";

const RUNTIME_REQUEST_TIMEOUT_MS = 30_000;

type PendingRuntimeRequest = {
	connectionId: string;
	resolve: (
		result: EnvironmentRpcResult<{
			response: EnvironmentRuntimeCommandResponse;
		}>
	) => void;
	timeout: ReturnType<typeof setTimeout>;
};

export class RuntimeCommandRouter {
	private readonly pendingRuntimeRequests = new Map<
		string,
		PendingRuntimeRequest
	>();

	handleResponse(input: {
		connectionId: string;
		response: EnvironmentRuntimeCommandResponse;
	}): boolean {
		const pending = this.pendingRuntimeRequests.get(input.response.requestId);
		if (!(pending && pending.connectionId === input.connectionId)) {
			return false;
		}

		clearTimeout(pending.timeout);
		this.pendingRuntimeRequests.delete(input.response.requestId);
		pending.resolve(
			okResult({
				response: input.response,
			})
		);
		return true;
	}

	rejectPendingForConnection(
		connectionId: string,
		error: EnvironmentRpcError
	): void {
		for (const [requestId, pending] of this.pendingRuntimeRequests) {
			if (pending.connectionId !== connectionId) {
				continue;
			}

			clearTimeout(pending.timeout);
			this.pendingRuntimeRequests.delete(requestId);
			pending.resolve({
				ok: false,
				error,
			});
		}
	}

	async sendCommand(input: {
		command: EnvironmentRuntimeCommand;
		getActiveRuntimeSocket: () => {
			socket: WebSocket;
			attachment: RuntimeSocketAttachment;
		} | null;
	}): Promise<
		EnvironmentRpcResult<{
			response: EnvironmentRuntimeCommandResponse;
		}>
	> {
		if (this.pendingRuntimeRequests.has(input.command.requestId)) {
			return errorResult(
				"runtime_request_already_pending",
				`Runtime request ${input.command.requestId} is already pending`
			);
		}

		const activeRuntime = input.getActiveRuntimeSocket();
		if (!activeRuntime) {
			return errorResult("runtime_not_connected", "Runtime is not connected");
		}

		return await new Promise<
			EnvironmentRpcResult<{
				response: EnvironmentRuntimeCommandResponse;
			}>
		>((resolve) => {
			const timeout = setTimeout(() => {
				this.pendingRuntimeRequests.delete(input.command.requestId);
				resolve(
					errorResult(
						"runtime_request_timed_out",
						`Timed out waiting for runtime response to ${input.command.requestId}`
					)
				);
			}, RUNTIME_REQUEST_TIMEOUT_MS);

			this.pendingRuntimeRequests.set(input.command.requestId, {
				connectionId: activeRuntime.attachment.connectionId,
				resolve,
				timeout,
			});

			try {
				activeRuntime.socket.send(JSON.stringify(input.command));
			} catch (error) {
				clearTimeout(timeout);
				this.pendingRuntimeRequests.delete(input.command.requestId);
				resolve(
					errorResult(
						"runtime_request_send_failed",
						error instanceof Error ? error.message : String(error)
					)
				);
			}
		});
	}
}
