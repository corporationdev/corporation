import { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
import {
	zPromptRequest,
	zSessionNotification,
} from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import type { SessionEvent as ClientSessionEvent } from "@corporation/contracts/browser-do";
import type { SessionEvent as SandboxSessionEvent } from "@corporation/contracts/sandbox-do";

function getTextContent(value: unknown): string | null {
	if (
		value &&
		typeof value === "object" &&
		"type" in value &&
		value.type === "text" &&
		"text" in value &&
		typeof value.text === "string"
	) {
		return value.text;
	}
	return null;
}

function getPromptText(prompt: unknown[]): string | null {
	const text = prompt
		.map((part) => getTextContent(part))
		.filter((part): part is string => part !== null)
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.join("\n\n")
		.trim();
	return text.length > 0 ? text : null;
}

function getBaseEvent(
	event: SandboxSessionEvent
): Pick<ClientSessionEvent, "createdAt" | "id" | "sender" | "sessionId"> {
	return {
		id: event.id,
		createdAt: event.createdAt,
		sender: event.sender,
		sessionId: event.sessionId,
	};
}

export function normalizeSessionEvent(
	event: SandboxSessionEvent
): ClientSessionEvent {
	const base = getBaseEvent(event);
	const payload = event.payload;

	if ("method" in payload) {
		if (
			event.sender === "client" &&
			payload.method === AGENT_METHODS.session_prompt
		) {
			const request = zPromptRequest.parse(payload.params);
			return {
				...base,
				kind: "user_prompt",
				request,
				requestId: "id" in payload ? payload.id : null,
				text: getPromptText(request.prompt),
			};
		}

		if (
			event.sender === "agent" &&
			payload.method === CLIENT_METHODS.session_update
		) {
			const notification = zSessionNotification.parse(payload.params);
			const update = notification.update;

			switch (update.sessionUpdate) {
				case "user_message_chunk":
					return {
						...base,
						kind: "user_message_chunk",
						text: getTextContent(update.content),
						update,
					};
				case "agent_message_chunk":
					return {
						...base,
						kind: "agent_message_chunk",
						text: getTextContent(update.content),
						update,
					};
				case "agent_thought_chunk":
					return {
						...base,
						kind: "agent_thought_chunk",
						text: getTextContent(update.content),
						update,
					};
				case "tool_call":
					return {
						...base,
						kind: "tool_call",
						toolCallId: update.toolCallId,
						title: update.title,
						status: update.status ?? null,
						rawInput: update.rawInput,
						rawOutput: update.rawOutput,
						update,
					};
				case "tool_call_update":
					return {
						...base,
						kind: "tool_call_update",
						toolCallId: update.toolCallId,
						title: update.title,
						status: update.status,
						rawInput: update.rawInput,
						rawOutput: update.rawOutput,
						update,
					};
				case "plan":
					return {
						...base,
						kind: "plan",
						update,
					};
				case "available_commands_update":
					return {
						...base,
						kind: "available_commands_update",
						update,
					};
				case "current_mode_update":
					return {
						...base,
						kind: "current_mode_update",
						update,
					};
				case "config_option_update":
					return {
						...base,
						kind: "config_option_update",
						update,
					};
				case "session_info_update":
					return {
						...base,
						kind: "session_info_update",
						update,
					};
				case "usage_update":
					return {
						...base,
						kind: "usage_update",
						update,
					};
				default: {
					const exhaustiveCheck: never = update;
					throw new Error(
						`Unhandled ACP session update: ${JSON.stringify(exhaustiveCheck)}`
					);
				}
			}
		}

		if ("id" in payload) {
			return {
				...base,
				kind: "acp_request",
				method: payload.method,
				params: payload.params,
				requestId: payload.id,
			};
		}

		return {
			...base,
			kind: "acp_notification",
			method: payload.method,
			params: payload.params,
		};
	}

	if ("result" in payload) {
		return {
			...base,
			kind: "acp_response",
			requestId: payload.id,
			result: payload.result,
		};
	}

	return {
		...base,
		kind: "acp_error",
		error: payload.error,
		requestId: payload.id,
	};
}
