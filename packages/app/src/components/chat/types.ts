export type PromptAttachment = {
	name: string;
	mimeType: string;
	uri: string;
};

export type ComposerImageAttachment = {
	id: string;
	file: File;
	name: string;
	mimeType: string;
	size: number;
	previewUrl: string;
};

export type TimelineEntry = {
	id: string;
	kind: "message" | "tool" | "reasoning" | "meta";
	time: string;
	role?: "user" | "assistant";
	text?: string;
	attachments?: PromptAttachment[];
	toolName?: string;
	toolInput?: string;
	toolOutput?: string;
	toolStatus?: string;
	reasoning?: { text: string; visibility?: string };
	meta?: { title: string; detail?: string; severity?: "info" | "error" };
};
