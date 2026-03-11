export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

type TimelineEntryBase = {
	id: string;
	time: string;
};

export type MessageTimelineEntry = TimelineEntryBase & {
	kind: "message";
	role: "user" | "assistant";
	text: string;
};

export type ToolTimelineEntry = TimelineEntryBase & {
	kind: "tool";
	toolName?: string;
	toolInput?: string;
	toolOutput?: string;
	toolStatus: ToolStatus;
};

export type ReasoningTimelineEntry = TimelineEntryBase & {
	kind: "reasoning";
	reasoning: { text: string; visibility?: string };
};

export type MetaTimelineEntry = TimelineEntryBase & {
	kind: "meta";
	meta: { title: string; detail?: string; severity?: "info" | "error" };
};

export type TimelineEntry =
	| MessageTimelineEntry
	| ToolTimelineEntry
	| ReasoningTimelineEntry
	| MetaTimelineEntry;
