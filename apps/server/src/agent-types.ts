import type { UniversalEvent } from "sandbox-agent";

export type SandboxAgentMethods = {
	get state(): unknown;
	sendMessage(content: string): Promise<void>;
};

export type ServerMessage = {
	type: "event";
	data: UniversalEvent;
};
