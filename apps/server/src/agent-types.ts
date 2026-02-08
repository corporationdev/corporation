import type { UniversalEvent } from "sandbox-agent";

export type SandboxInfo = {
	sandboxId: string;
	status: "creating" | "ready" | "error";
	createdAt: string;
};

export type SandboxState = {
	sandbox: SandboxInfo | null;
	previewUrl: string | null;
	events: UniversalEvent[];
};

export type SandboxAgentMethods = {
	get state(): SandboxState;
	sendMessage(content: string): Promise<void>;
	replyPermission(
		permissionId: string,
		reply: "once" | "always" | "reject"
	): Promise<void>;
};
