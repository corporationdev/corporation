import type {
	AvailableCommand,
	ContentBlock,
	Diff,
	EmbeddedResource,
	RequestPermissionRequest,
	SessionConfigOption,
	SessionConfigSelectGroup,
	SessionConfigSelectOption,
	SessionUpdate,
	Terminal,
	ToolCall,
	ToolCallContent,
	ToolCallLocation,
	ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { SessionId, TurnId } from "./index";
import type {
	RuntimeAvailableCommand,
	RuntimeContent,
	RuntimeEvent,
	RuntimePermissionOption,
	RuntimeSessionConfigOption,
	RuntimeSessionConfigOptionGroup,
	RuntimeSessionConfigOptionValue,
	RuntimeToolCall,
	RuntimeToolContent,
	RuntimeToolLocation,
} from "./runtime-events";

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
				...(content.uri !== undefined ? { uri: content.uri } : {}),
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
				...(content.title !== undefined ? { title: content.title } : {}),
				...(content.description !== undefined
					? { description: content.description }
					: {}),
				...(content.mimeType !== undefined
					? { mimeType: content.mimeType }
					: {}),
				...(content.size !== undefined ? { size: content.size } : {}),
			};
		case "resource":
			return normalizeEmbeddedResource(content);
		default: {
			const exhaustiveCheck: never = content;
			throw new Error(
				`Unhandled ACP content block: ${JSON.stringify(exhaustiveCheck)}`
			);
		}
	}
}

function normalizeEmbeddedResource(content: EmbeddedResource): RuntimeContent {
	const resource = content.resource;
	if ("text" in resource) {
		return {
			type: "resource",
			uri: resource.uri,
			...(resource.mimeType !== undefined
				? { mimeType: resource.mimeType }
				: {}),
			text: resource.text,
		};
	}

	return {
		type: "resource",
		uri: resource.uri,
		...(resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {}),
		blob: resource.blob,
	};
}

function normalizeToolLocation(
	location: ToolCallLocation
): RuntimeToolLocation {
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
			return normalizeDiff(content);
		case "terminal":
			return normalizeTerminal(content);
		default: {
			const exhaustiveCheck: never = content;
			throw new Error(
				`Unhandled ACP tool content: ${JSON.stringify(exhaustiveCheck)}`
			);
		}
	}
}

function normalizeDiff(content: Diff): RuntimeToolContent {
	return {
		type: "diff",
		path: content.path,
		newText: content.newText,
		...(content.oldText !== undefined ? { oldText: content.oldText } : {}),
	};
}

function normalizeTerminal(content: Terminal): RuntimeToolContent {
	return {
		type: "terminal",
		terminalId: content.terminalId,
	};
}

function normalizeToolCallBase(
	update: ToolCall | ToolCallUpdate
): RuntimeToolCall {
	return {
		toolCallId: update.toolCallId,
		title: "title" in update ? (update.title ?? null) : null,
		status: "status" in update ? (update.status ?? null) : null,
		...("kind" in update ? { kind: update.kind ?? null } : {}),
		...("locations" in update && update.locations !== undefined
			? {
					locations:
						update.locations === null
							? null
							: update.locations.map(normalizeToolLocation),
				}
			: {}),
		...("content" in update && update.content !== undefined
			? {
					content:
						update.content === null
							? null
							: update.content.map(normalizeToolContent),
				}
			: {}),
		...("rawInput" in update && update.rawInput !== undefined
			? { rawInput: update.rawInput }
			: {}),
		...("rawOutput" in update && update.rawOutput !== undefined
			? { rawOutput: update.rawOutput }
			: {}),
	};
}

function normalizeCommand(command: AvailableCommand): RuntimeAvailableCommand {
	return {
		name: command.name,
		description: command.description,
		...(command.input ? { inputHint: command.input.hint } : {}),
	};
}

function normalizePermissionOption(
	option: RequestPermissionRequest["options"][number]
): RuntimePermissionOption {
	return {
		optionId: option.optionId,
		kind: option.kind,
		name: option.name,
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

export function normalizeAcpSessionUpdate(
	sessionId: SessionId,
	turnId: TurnId,
	update: SessionUpdate
): RuntimeEvent {
	switch (update.sessionUpdate) {
		case "user_message_chunk": {
			const content = normalizeContent(update.content);
			return {
				type: "output.delta",
				sessionId,
				turnId,
				channel: "user",
				content,
			};
		}
		case "agent_message_chunk": {
			const content = normalizeContent(update.content);
			return {
				type: "output.delta",
				sessionId,
				turnId,
				channel: "assistant",
				content,
			};
		}
		case "agent_thought_chunk": {
			const content = normalizeContent(update.content);
			return {
				type: "output.delta",
				sessionId,
				turnId,
				channel: "thought",
				content,
			};
		}
		case "tool_call":
			return {
				type: "tool.started",
				sessionId,
				turnId,
				toolCall: normalizeToolCallBase(update),
			};
		case "tool_call_update":
			return {
				type: "tool.updated",
				sessionId,
				turnId,
				toolCall: normalizeToolCallBase(update),
			};
		case "plan":
			return {
				type: "plan.updated",
				sessionId,
				turnId,
				entries: update.entries.map((entry) => ({
					content: entry.content,
					priority: entry.priority,
					status: entry.status,
				})),
			};
		case "available_commands_update":
			return {
				type: "session.available_commands.updated",
				sessionId,
				turnId,
				commands: update.availableCommands.map(normalizeCommand),
			};
		case "current_mode_update":
			return {
				type: "session.mode.updated",
				sessionId,
				turnId,
				modeId: update.currentModeId,
			};
		case "config_option_update":
			return {
				type: "session.config.updated",
				sessionId,
				turnId,
				configOptions: update.configOptions.map(normalizeSessionConfigOption),
			};
		case "session_info_update":
			return {
				type: "session.info.updated",
				sessionId,
				turnId,
				...(update.title !== undefined ? { title: update.title } : {}),
				...(update.updatedAt !== undefined
					? { updatedAt: update.updatedAt }
					: {}),
			};
		case "usage_update":
			return {
				type: "usage.updated",
				sessionId,
				turnId,
				used: update.used,
				size: update.size,
				...(update.cost !== undefined ? { cost: update.cost } : {}),
			};
		default: {
			const exhaustiveCheck: never = update;
			throw new Error(
				`Unhandled ACP session update: ${JSON.stringify(exhaustiveCheck)}`
			);
		}
	}
}

export function normalizeAcpPermissionRequest(
	sessionId: SessionId,
	turnId: TurnId,
	requestId: string,
	request: RequestPermissionRequest
): RuntimeEvent {
	return {
		type: "permission.requested",
		sessionId,
		turnId,
		requestId,
		options: request.options.map(normalizePermissionOption),
		toolCall: normalizeToolCallBase(request.toolCall),
	};
}
