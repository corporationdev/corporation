import type {
	RuntimeCommandRejectedMessage,
	RuntimeProbeResultMessage,
	RuntimeSessionEventBatchMessage,
	RuntimeTurnCompletedMessage,
	RuntimeTurnFailedMessage,
} from "@corporation/contracts/sandbox-do";
import { type Effect, ServiceMap } from "effect";
import type { RuntimeTransportUnavailableError } from "./errors";

export type TransportStatus =
	| { state: "connecting" }
	| { state: "connected"; connectedAt: number }
	| { state: "disconnected"; reason: string };

export type RuntimeTransportMessage =
	| RuntimeSessionEventBatchMessage
	| RuntimeTurnCompletedMessage
	| RuntimeTurnFailedMessage
	| RuntimeProbeResultMessage
	| RuntimeCommandRejectedMessage;

export type RuntimeTransportShape = {
	status: () => Effect.Effect<TransportStatus>;
	send: (
		message: RuntimeTransportMessage
	) => Effect.Effect<void, RuntimeTransportUnavailableError>;
};

export class RuntimeTransport extends ServiceMap.Service<
	RuntimeTransport,
	RuntimeTransportShape
>()("sandbox-runtime/RuntimeTransport") {}
