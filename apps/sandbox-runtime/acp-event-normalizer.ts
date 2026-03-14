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
import type {
	ConfigOption,
	ConfigOptionValue,
	Content,
	AvailableCommand as EventAvailableCommand,
	ToolCall as EventToolCall,
	PermissionOption,
	PlanEntry,
	SessionEvent,
	ToolContent,
	ToolLocation,
} from "@corporation/contracts/session-event";

function normalizeContent(content: ContentBlock): Content {
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

function normalizeEmbeddedResource(content: EmbeddedResource): Content {
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

function normalizeToolLocation(location: ToolCallLocation): ToolLocation {
	return {
		path: location.path,
		...(location.line !== undefined ? { line: location.line } : {}),
	};
}

function normalizeToolContent(content: ToolCallContent): ToolContent {
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

function normalizeDiff(content: Diff): ToolContent {
	return {
		type: "diff",
		path: content.path,
		newText: content.newText,
		...(content.oldText !== undefined ? { oldText: content.oldText } : {}),
	};
}

function normalizeTerminal(content: Terminal): ToolContent {
	return {
		type: "terminal",
		terminalId: content.terminalId,
	};
}

function normalizeToolCallBase(
	update: ToolCall | ToolCallUpdate
): EventToolCall {
	return {
		toolCallId: update.toolCallId,
		title: "title" in update ? (update.title ?? null) : null,
		status: "status" in update ? (update.status ?? null) : null,
		...("kind" in update ? { toolKind: update.kind ?? null } : {}),
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

function normalizeCommand(command: AvailableCommand): EventAvailableCommand {
	return {
		name: command.name,
		description: command.description,
		...(command.input ? { inputHint: command.input.hint } : {}),
	};
}

function normalizePermissionOption(
	option: RequestPermissionRequest["options"][number]
): PermissionOption {
	return {
		optionId: option.optionId,
		kind: option.kind,
		name: option.name,
	};
}

function normalizeSessionConfigOptionValue(
	option: SessionConfigSelectOption
): ConfigOptionValue {
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
): ConfigOption["options"][number] {
	return {
		group: group.group,
		name: group.name,
		options: group.options.map(normalizeSessionConfigOptionValue),
	};
}

function normalizeSessionConfigOption(
	option: SessionConfigOption
): ConfigOption {
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

function normalizePlanEntry(
	entry: SessionUpdate extends infer U
		? U extends { sessionUpdate: "plan"; entries: infer E }
			? E extends Array<infer Item>
				? Item
				: never
			: never
		: never
): PlanEntry {
	return {
		content: entry.content,
		priority: entry.priority,
		status: entry.status,
	};
}

export function normalizeAcpSessionUpdate(
	sessionId: string,
	update: SessionUpdate
): SessionEvent {
	switch (update.sessionUpdate) {
		case "user_message_chunk": {
			const content = normalizeContent(update.content);
			return {
				kind: "text_delta",
				sessionId,
				channel: "user",
				content,
			};
		}
		case "agent_message_chunk": {
			const content = normalizeContent(update.content);
			return {
				kind: "text_delta",
				sessionId,
				channel: "assistant",
				content,
			};
		}
		case "agent_thought_chunk": {
			const content = normalizeContent(update.content);
			return {
				kind: "text_delta",
				sessionId,
				channel: "thinking",
				content,
			};
		}
		case "tool_call":
			return {
				kind: "tool_start",
				sessionId,
				toolCall: normalizeToolCallBase(update),
			};
		case "tool_call_update":
			return {
				kind: "tool_update",
				sessionId,
				toolCall: normalizeToolCallBase(update),
			};
		case "plan":
			return {
				kind: "plan",
				sessionId,
				entries: update.entries.map(normalizePlanEntry),
			};
		case "available_commands_update":
			return {
				kind: "commands_changed",
				sessionId,
				commands: update.availableCommands.map(normalizeCommand),
			};
		case "current_mode_update":
			return {
				kind: "mode_changed",
				sessionId,
				modeId: update.currentModeId,
			};
		case "config_option_update":
			return {
				kind: "config_changed",
				sessionId,
				configOptions: update.configOptions.map(normalizeSessionConfigOption),
			};
		case "session_info_update":
			return {
				kind: "info_changed",
				sessionId,
				...(update.title !== undefined ? { title: update.title } : {}),
				...(update.updatedAt !== undefined
					? { updatedAt: update.updatedAt }
					: {}),
			};
		case "usage_update":
			return {
				kind: "usage",
				sessionId,
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
	sessionId: string,
	requestId: string,
	request: RequestPermissionRequest
): SessionEvent {
	return {
		kind: "permission_request",
		sessionId,
		requestId,
		options: request.options.map(normalizePermissionOption),
		toolCall: normalizeToolCallBase(request.toolCall),
	};
}
