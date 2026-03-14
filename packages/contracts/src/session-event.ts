import { z } from "zod";

// --- Shared sub-types ---

export const toolStatusSchema = z.enum([
	"pending",
	"in_progress",
	"completed",
	"failed",
]);
export type ToolStatus = z.infer<typeof toolStatusSchema>;

export const contentSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("text"),
		text: z.string(),
	}),
	z.object({
		type: z.literal("image"),
		mimeType: z.string(),
		uri: z.string().nullable().optional(),
	}),
	z.object({
		type: z.literal("audio"),
		mimeType: z.string(),
		data: z.string(),
	}),
	z.object({
		type: z.literal("resource_link"),
		uri: z.string(),
		name: z.string(),
		title: z.string().nullable().optional(),
		description: z.string().nullable().optional(),
		mimeType: z.string().nullable().optional(),
		size: z.number().nullable().optional(),
	}),
	z.object({
		type: z.literal("resource"),
		uri: z.string(),
		mimeType: z.string().nullable().optional(),
		text: z.string().optional(),
		blob: z.string().optional(),
	}),
]);
export type Content = z.infer<typeof contentSchema>;

export const toolLocationSchema = z.object({
	path: z.string(),
	line: z.number().nullable().optional(),
});
export type ToolLocation = z.infer<typeof toolLocationSchema>;

export const toolContentSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("content"),
		content: contentSchema,
	}),
	z.object({
		type: z.literal("diff"),
		path: z.string(),
		newText: z.string(),
		oldText: z.string().nullable().optional(),
	}),
	z.object({
		type: z.literal("terminal"),
		terminalId: z.string(),
	}),
]);
export type ToolContent = z.infer<typeof toolContentSchema>;

export const toolCallSchema = z.object({
	toolCallId: z.string(),
	title: z.string().nullable(),
	status: toolStatusSchema.nullable(),
	toolKind: z.string().nullable().optional(),
	locations: z.array(toolLocationSchema).nullable().optional(),
	content: z.array(toolContentSchema).nullable().optional(),
	rawInput: z.unknown().optional(),
	rawOutput: z.unknown().optional(),
});
export type ToolCall = z.infer<typeof toolCallSchema>;

export const planEntrySchema = z.object({
	content: z.string(),
	priority: z.string(),
	status: z.string(),
});
export type PlanEntry = z.infer<typeof planEntrySchema>;

export const permissionOptionSchema = z.object({
	optionId: z.string(),
	kind: z.string(),
	name: z.string(),
});
export type PermissionOption = z.infer<typeof permissionOptionSchema>;

export const configOptionValueSchema = z.object({
	name: z.string(),
	value: z.string(),
	description: z.string().nullable().optional(),
});
export type ConfigOptionValue = z.infer<typeof configOptionValueSchema>;

export const configOptionGroupSchema = z.object({
	group: z.string(),
	name: z.string(),
	options: z.array(configOptionValueSchema),
});

export const configOptionSchema = z.object({
	type: z.literal("select"),
	id: z.string(),
	name: z.string(),
	currentValue: z.string(),
	options: z.array(z.union([configOptionValueSchema, configOptionGroupSchema])),
	description: z.string().nullable().optional(),
	category: z.string().nullable().optional(),
});
export type ConfigOption = z.infer<typeof configOptionSchema>;

export const availableCommandSchema = z.object({
	name: z.string(),
	description: z.string(),
	inputHint: z.string().nullable().optional(),
});
export type AvailableCommand = z.infer<typeof availableCommandSchema>;

export const textDeltaChannelSchema = z.enum(["user", "assistant", "thinking"]);
export type TextDeltaChannel = z.infer<typeof textDeltaChannelSchema>;

// --- Session event (unified, one source of truth) ---

const sessionEventBase = z.object({
	sessionId: z.string(),
});

export const sessionEventSchema = z.discriminatedUnion("kind", [
	// Session lifecycle
	sessionEventBase.extend({
		kind: z.literal("status"),
		status: z.enum(["running", "idle", "error"]),
		error: z.string().optional(),
		stopReason: z.string().optional(),
	}),

	// Content
	sessionEventBase.extend({
		kind: z.literal("text_delta"),
		channel: textDeltaChannelSchema,
		content: contentSchema,
	}),

	// Tool lifecycle
	sessionEventBase.extend({
		kind: z.literal("tool_start"),
		toolCall: toolCallSchema,
	}),
	sessionEventBase.extend({
		kind: z.literal("tool_update"),
		toolCall: toolCallSchema,
	}),

	// Planning
	sessionEventBase.extend({
		kind: z.literal("plan"),
		entries: z.array(planEntrySchema),
	}),

	// Usage
	sessionEventBase.extend({
		kind: z.literal("usage"),
		used: z.number(),
		size: z.number(),
		cost: z
			.object({
				amount: z.number(),
				currency: z.string(),
			})
			.nullable()
			.optional(),
	}),

	// Permissions
	sessionEventBase.extend({
		kind: z.literal("permission_request"),
		requestId: z.string(),
		options: z.array(permissionOptionSchema),
		toolCall: toolCallSchema,
	}),

	// Session metadata
	sessionEventBase.extend({
		kind: z.literal("mode_changed"),
		modeId: z.string(),
	}),
	sessionEventBase.extend({
		kind: z.literal("config_changed"),
		configOptions: z.array(configOptionSchema),
	}),
	sessionEventBase.extend({
		kind: z.literal("info_changed"),
		title: z.string().nullable().optional(),
		updatedAt: z.string().nullable().optional(),
	}),
	sessionEventBase.extend({
		kind: z.literal("commands_changed"),
		commands: z.array(availableCommandSchema),
	}),
]);

export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionEventKind = SessionEvent["kind"];
