export type TimelineEntry = {
	id: string;
	kind: "message" | "tool" | "reasoning" | "meta";
	time: string;
	role?: "user" | "assistant";
	text?: string;
	toolName?: string;
	toolInput?: string;
	toolOutput?: string;
	toolStatus?: string;
	reasoning?: { text: string; visibility?: string };
	meta?: { title: string; detail?: string; severity?: "info" | "error" };
};
