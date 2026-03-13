import type {
	AvailableCommand,
	ContentBlock,
	RequestPermissionRequest,
	SessionConfigOption,
	SessionConfigSelectGroup,
	SessionConfigSelectOption,
	SessionUpdate,
	ToolCall,
	ToolCallContent,
	ToolCallLocation,
	ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { RuntimeEvent } from "./runtime-events";
import type {
	RuntimeAvailableCommand,
	RuntimeContent,
	RuntimeMessagePart,
	RuntimePermissionRequest,
	RuntimeSessionConfigOption,
	RuntimeSessionConfigOptionGroup,
	RuntimeSessionConfigOptionValue,
	RuntimeTodo,
	RuntimeToolContent,
	RuntimeToolLocation,
	RuntimeToolPart,
	RuntimeToolState,
} from "./runtime-types";

export type AcpEventProjectionState = {
	textPart: Extract<RuntimeMessagePart, { type: "text" }> | null;
	reasoningPart: Extract<RuntimeMessagePart, { type: "reasoning" }> | null;
	toolParts: Map<string, RuntimeToolPart>;
	todos: RuntimeTodo[];
};

export type NormalizedAcpEvents = RuntimeEvent[];

function toDataUrl(mimeType: string, data: string): string {
	return `data:${mimeType};base64,${data}`;
}

function normalizeContent(content: ContentBlock): RuntimeContent {
	switch (content.type) {
		case "text":
			return {
				type: "text",
				text: content.text,
			};
		case "image":
			return {
				type: "image",
				mimeType: content.mimeType,
				uri: content.uri ?? "",
			};
		case "audio":
			return {
				type: "audio",
				mimeType: content.mimeType,
				data: content.data,
			};
		case "resource_link":
			return {
				type: "resource_link",
				uri: content.uri,
				name: content.name,
				...(content.title != null ? { title: content.title } : {}),
				...(content.description != null
					? { description: content.description }
					: {}),
				...(content.mimeType != null
					? { mimeType: content.mimeType }
					: {}),
				...(content.size != null ? { size: content.size } : {}),
			};
		case "resource": {
			const resource = content.resource;
			if ("text" in resource) {
				return {
					type: "resource",
					uri: resource.uri,
					...(resource.mimeType != null
						? { mimeType: resource.mimeType }
						: {}),
					text: resource.text,
				};
			}

			return {
				type: "resource",
				uri: resource.uri,
				...(resource.mimeType != null
					? { mimeType: resource.mimeType }
					: {}),
				blob: resource.blob,
			};
		}
		default: {
			const exhaustiveCheck: never = content;
			throw new Error(
				`Unhandled ACP content block: ${JSON.stringify(exhaustiveCheck)}`
			);
		}
	}
}

function toFilePart(
	sessionId: string,
	messageId: string,
	content: RuntimeContent
): Extract<RuntimeMessagePart, { type: "file" }> {
	switch (content.type) {
		case "image":
			return {
				id: crypto.randomUUID(),
				sessionId,
				messageId,
				type: "file",
				mimeType: content.mimeType,
				uri: content.uri,
			};
		case "audio":
			return {
				id: crypto.randomUUID(),
				sessionId,
				messageId,
				type: "file",
				mimeType: content.mimeType,
				uri: toDataUrl(content.mimeType, content.data),
			};
		case "resource_link":
			return {
				id: crypto.randomUUID(),
				sessionId,
				messageId,
				type: "file",
				mimeType: content.mimeType ?? "application/octet-stream",
				uri: content.uri,
				...(content.name ? { filename: content.name } : {}),
			};
		case "resource":
			return {
				id: crypto.randomUUID(),
				sessionId,
				messageId,
				type: "file",
				mimeType: content.mimeType ?? "application/octet-stream",
				uri:
					content.text !== undefined
						? toDataUrl(
								content.mimeType ?? "text/plain",
								btoa(content.text)
							)
						: toDataUrl(
								content.mimeType ?? "application/octet-stream",
								content.blob ?? ""
							),
			};
		default:
			throw new Error(`Cannot convert ${content.type} to a file part`);
	}
}

function normalizeToolLocation(location: ToolCallLocation): RuntimeToolLocation {
	return {
		path: location.path,
		...(location.line !== undefined ? { line: location.line } : {}),
	};
}

function normalizeToolContent(content: ToolCallContent): RuntimeToolContent {
	switch (content.type) {
		case "content":
			return {
				type: "content",
				content: normalizeContent(content.content),
			};
		case "diff":
			return {
				type: "diff",
				path: content.path,
				newText: content.newText,
				...(content.oldText !== undefined ? { oldText: content.oldText } : {}),
			};
		case "terminal":
			return {
				type: "terminal",
				terminalId: content.terminalId,
			};
		default: {
			const exhaustiveCheck: never = content;
			throw new Error(
				`Unhandled ACP tool content: ${JSON.stringify(exhaustiveCheck)}`
			);
		}
	}
}

function toToolMetadata(update: ToolCall | ToolCallUpdate) {
	const locations = update.locations?.map(normalizeToolLocation);
	const content = update.content?.map(normalizeToolContent);
	return locations || content || update.kind
		? {
				...(update.kind ? { kind: update.kind } : {}),
				...(locations ? { locations } : {}),
				...(content ? { content } : {}),
			}
		: undefined;
}

function toToolState(update: ToolCall | ToolCallUpdate): RuntimeToolState {
	const input =
		typeof update.rawInput === "object" && update.rawInput !== null
			? (update.rawInput as Record<string, unknown>)
			: {};
	const metadata = toToolMetadata(update);

	switch (update.status) {
		case "pending":
			return {
				status: "pending",
				input,
				raw: JSON.stringify(update.rawInput ?? {}),
			};
		case "in_progress":
			return {
				status: "running",
				input,
				...(update.title ? { title: update.title } : {}),
				startedAt: Date.now(),
				...(metadata ? { metadata } : {}),
			};
		case "completed":
			return {
				status: "completed",
				input,
				title: update.title ?? "Tool",
				output:
					typeof update.rawOutput === "string"
						? update.rawOutput
						: JSON.stringify(update.rawOutput ?? {}),
				startedAt: Date.now(),
				endedAt: Date.now(),
				...(metadata ? { metadata } : {}),
			};
		case "failed":
			return {
				status: "error",
				input,
				error:
					typeof update.rawOutput === "string"
						? update.rawOutput
						: JSON.stringify(update.rawOutput ?? {}),
				startedAt: Date.now(),
				endedAt: Date.now(),
				...(metadata ? { metadata } : {}),
			};
		default:
			return {
				status: "pending",
				input,
				raw: JSON.stringify(update.rawInput ?? {}),
			};
	}
}

function updateToolPart(
	sessionId: string,
	messageId: string,
	state: AcpEventProjectionState,
	update: ToolCall | ToolCallUpdate
): RuntimeToolPart {
	const existing = state.toolParts.get(update.toolCallId);
	const toolPart: RuntimeToolPart = {
		id: existing?.id ?? crypto.randomUUID(),
		sessionId,
		messageId,
		type: "tool",
		toolCallId: update.toolCallId,
		tool: update.title ?? update.kind ?? "tool",
		state: toToolState(update),
		...(update.kind ||
		update.locations ||
		update.content ||
		update.rawInput !== undefined ||
		update.rawOutput !== undefined
			? {
					metadata: {
						...(update.kind ? { kind: update.kind } : {}),
						...(update.locations
							? {
									locations: update.locations.map(normalizeToolLocation),
								}
							: {}),
						...(update.content
							? {
									content: update.content.map(normalizeToolContent),
								}
							: {}),
						...(update.rawInput !== undefined
							? { rawInput: update.rawInput }
							: {}),
						...(update.rawOutput !== undefined
							? { rawOutput: update.rawOutput }
							: {}),
					},
				}
			: {}),
	};
	state.toolParts.set(update.toolCallId, toolPart);
	return toolPart;
}

function normalizeAvailableCommand(
	command: AvailableCommand
): RuntimeAvailableCommand {
	return {
		name: command.name,
		description: command.description,
		...(command.input ? { inputHint: command.input.hint } : {}),
	};
}

function normalizePermissionRequest(
	sessionId: string,
	messageId: string,
	requestId: string,
	request: RequestPermissionRequest
): RuntimePermissionRequest {
	return {
		id: requestId,
		sessionId,
		permission: request.toolCall?.title ?? "permission",
		options: request.options.map((option) => ({
			optionId: option.optionId,
			kind: option.kind,
			name: option.name,
		})),
		always: request.options
			.filter((option) => option.kind === "allow_always")
			.map((option) => option.name),
		...(request.toolCall?.toolCallId
			? {
					messageId,
					toolCallId: request.toolCall.toolCallId,
				}
			: {}),
	};
}

function normalizeSessionConfigOptionValue(
	option: SessionConfigSelectOption
): RuntimeSessionConfigOptionValue {
	return {
		name: option.name,
		value: option.value,
		...(option.description !== undefined
			? { description: option.description }
			: {}),
	};
}

function normalizeSessionConfigOptionGroup(
	group: SessionConfigSelectGroup
): RuntimeSessionConfigOptionGroup {
	return {
		group: group.group,
		name: group.name,
		options: group.options.map(normalizeSessionConfigOptionValue),
	};
}

function normalizeSessionConfigOption(
	option: SessionConfigOption
): RuntimeSessionConfigOption {
	return {
		type: "select",
		id: option.id,
		name: option.name,
		currentValue: option.currentValue,
		options: option.options.map((entry) =>
			"group" in entry
				? normalizeSessionConfigOptionGroup(entry)
				: normalizeSessionConfigOptionValue(entry)
		),
		...(option.description !== undefined
			? { description: option.description }
			: {}),
		...(option.category !== undefined ? { category: option.category } : {}),
	};
}

export function createAcpProjectionState(): AcpEventProjectionState {
	return {
		textPart: null,
		reasoningPart: null,
		toolParts: new Map(),
		todos: [],
	};
}

export function normalizeAcpSessionUpdate(
	sessionId: string,
	messageId: string,
	state: AcpEventProjectionState,
	update: SessionUpdate
): NormalizedAcpEvents {
	switch (update.sessionUpdate) {
		case "user_message_chunk":
			return [];
		case "agent_message_chunk": {
			const content = normalizeContent(update.content);
			if (content.type === "text") {
				const previousText = state.textPart?.text ?? "";
				state.textPart = {
					id: state.textPart?.id ?? crypto.randomUUID(),
					sessionId,
					messageId,
					type: "text",
					text: previousText + content.text,
				};
				return [
					{
						type: "message.part.updated",
						part: state.textPart,
					},
					{
						type: "message.part.delta",
						sessionId,
						messageId,
						partId: state.textPart.id,
						field: "text",
						delta: content.text,
					},
				];
			}

			return [
				{
					type: "message.part.updated",
					part: toFilePart(sessionId, messageId, content),
				},
			];
		}
		case "agent_thought_chunk": {
			const content = normalizeContent(update.content);
			if (content.type !== "text") {
				return [];
			}
			const previousText = state.reasoningPart?.text ?? "";
			state.reasoningPart = {
				id: state.reasoningPart?.id ?? crypto.randomUUID(),
				sessionId,
				messageId,
				type: "reasoning",
				text: previousText + content.text,
				startedAt: state.reasoningPart?.startedAt ?? Date.now(),
			};
			return [
				{
					type: "message.part.updated",
					part: state.reasoningPart,
				},
				{
					type: "message.part.delta",
					sessionId,
					messageId,
					partId: state.reasoningPart.id,
					field: "text",
					delta: content.text,
				},
			];
		}
		case "tool_call":
		case "tool_call_update":
			return [
				{
					type: "message.part.updated",
					part: updateToolPart(sessionId, messageId, state, update),
				},
			];
		case "plan":
			state.todos = update.entries.map((entry) => ({
				content: entry.content,
				priority: entry.priority,
				status: entry.status,
			}));
			return [
				{
					type: "todo.updated",
					sessionId,
					todos: state.todos,
				},
			];
		case "available_commands_update":
			return [
				{
					type: "session.available_commands.updated",
					sessionId,
					commands: update.availableCommands.map(normalizeAvailableCommand),
				},
			];
		case "current_mode_update":
			return [
				{
					type: "session.mode.updated",
					sessionId,
					modeId: update.currentModeId,
				},
			];
		case "config_option_update":
			return [
				{
					type: "session.config.updated",
					sessionId,
					configOptions: update.configOptions.map(normalizeSessionConfigOption),
				},
			];
		case "session_info_update":
			return [
				{
					type: "session.info.updated",
					sessionId,
					...(update.title != null ? { title: update.title } : {}),
					...(update.updatedAt != null
						? { updatedAt: update.updatedAt }
						: {}),
				},
			];
		case "usage_update":
			return [
				{
					type: "usage.updated",
					sessionId,
					usage: {
						used: update.used,
						size: update.size,
						...(update.cost !== undefined ? { cost: update.cost } : {}),
					},
				},
			];
		default: {
			const exhaustiveCheck: never = update;
			throw new Error(
				`Unhandled ACP session update: ${JSON.stringify(exhaustiveCheck)}`
			);
		}
	}
}

export function normalizeAcpPermissionRequest(
	sessionId: string,
	messageId: string,
	requestId: string,
	request: RequestPermissionRequest
): RuntimeEvent {
	return {
		type: "permission.requested",
		request: normalizePermissionRequest(sessionId, messageId, requestId, request),
	};
}
