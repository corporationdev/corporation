import type {
	EnvironmentRuntimeCommandResponse,
	EnvironmentStreamDeliveryItem,
	EnvironmentStreamOffset,
	RuntimeHelloMessage,
	RuntimeSocketAttachment,
	RuntimeStreamItemsMessage,
} from "./types";

export function compareRuntimeAttachments(
	left: RuntimeSocketAttachment,
	right: RuntimeSocketAttachment
): number {
	if (left.connectedAt !== right.connectedAt) {
		return right.connectedAt - left.connectedAt;
	}
	return right.connectionId.localeCompare(left.connectionId);
}

export function parseRuntimeHelloMessage(
	message: string | ArrayBuffer
): RuntimeHelloMessage | null {
	try {
		const payload =
			typeof message === "string"
				? message
				: new TextDecoder().decode(new Uint8Array(message));
		const parsed = JSON.parse(payload) as Record<string, unknown>;
		if (parsed.type === "hello" && parsed.runtime === "sandbox-runtime") {
			return {
				type: "hello",
				runtime: "sandbox-runtime",
			};
		}
		return null;
	} catch {
		return null;
	}
}

export function parseRuntimeResponseMessage(
	message: string | ArrayBuffer
): EnvironmentRuntimeCommandResponse | null {
	try {
		const payload =
			typeof message === "string"
				? message
				: new TextDecoder().decode(new Uint8Array(message));
		const parsed = JSON.parse(payload) as Record<string, unknown>;
		if (
			parsed.type !== "response" ||
			typeof parsed.requestId !== "string" ||
			typeof parsed.ok !== "boolean"
		) {
			return null;
		}

		if (parsed.ok) {
			return {
				type: "response",
				requestId: parsed.requestId,
				ok: true,
				result: parsed.result as EnvironmentRuntimeCommandResponse extends {
					ok: true;
					result: infer Result;
				}
					? Result
					: never,
			};
		}

		if (typeof parsed.error !== "string") {
			return null;
		}

		return {
			type: "response",
			requestId: parsed.requestId,
			ok: false,
			error: parsed.error,
		};
	} catch {
		return null;
	}
}

export function parseRuntimeStreamItemsMessage(
	message: string | ArrayBuffer
): RuntimeStreamItemsMessage | null {
	try {
		const payload =
			typeof message === "string"
				? message
				: new TextDecoder().decode(new Uint8Array(message));
		const parsed = JSON.parse(payload) as Record<string, unknown>;
		if (
			parsed.type !== "stream_items" ||
			typeof parsed.stream !== "string" ||
			typeof parsed.nextOffset !== "string" ||
			typeof parsed.upToDate !== "boolean" ||
			typeof parsed.streamClosed !== "boolean" ||
			!Array.isArray(parsed.items)
		) {
			return null;
		}

		return {
			type: "stream_items",
			stream: parsed.stream,
			items: parsed.items as EnvironmentStreamDeliveryItem[],
			nextOffset: parsed.nextOffset as EnvironmentStreamOffset,
			upToDate: parsed.upToDate,
			streamClosed: parsed.streamClosed,
		};
	} catch {
		return null;
	}
}
