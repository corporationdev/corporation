import { Data } from "effect";

export class TurnConflictError extends Data.TaggedError("TurnConflictError")<{
	readonly error:
		| "Turn already in progress"
		| "Session already has an active turn";
}> {}

export class SessionReuseError extends Data.TaggedError("SessionReuseError")<{
	readonly message: string;
}> {}

export class CallbackDeliveryError extends Data.TaggedError(
	"CallbackDeliveryError"
)<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export class AcpBridgeError extends Data.TaggedError("AcpBridgeError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export class ProbeError extends Data.TaggedError("ProbeError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export class RuntimeActionError extends Data.TaggedError("RuntimeActionError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export function toRuntimeActionError(
	message: string,
	cause?: unknown
): RuntimeActionError {
	return new RuntimeActionError({ message, cause });
}

export function toCallbackDeliveryError(
	message: string,
	cause?: unknown
): CallbackDeliveryError {
	return new CallbackDeliveryError({ message, cause });
}

export function toAcpBridgeError(
	message: string,
	cause?: unknown
): AcpBridgeError {
	return new AcpBridgeError({ message, cause });
}

export function toProbeError(message: string, cause?: unknown): ProbeError {
	return new ProbeError({ message, cause });
}
