import type {
	EnvironmentRuntimeCommandResponse,
	EnvironmentRuntimeHello as RuntimeHelloMessage,
	EnvironmentRuntimeStreamItemsMessage as RuntimeStreamItemsMessage,
} from "@corporation/contracts/environment-runtime";
import {
	environmentRuntimeCommandResponseSchema,
	environmentRuntimeHelloSchema,
	environmentRuntimeStreamItemsMessageSchema,
} from "@corporation/contracts/environment-runtime";
import type { RuntimeSocketAttachment } from "./types";

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
		const parsed = environmentRuntimeHelloSchema.safeParse(JSON.parse(payload));
		return parsed.success ? parsed.data : null;
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
		const parsed = environmentRuntimeCommandResponseSchema.safeParse(
			JSON.parse(payload)
		);
		return parsed.success
			? (parsed.data as EnvironmentRuntimeCommandResponse)
			: null;
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
		const parsed = environmentRuntimeStreamItemsMessageSchema.safeParse(
			JSON.parse(payload)
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
