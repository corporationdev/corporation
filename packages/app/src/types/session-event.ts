export type SessionEventSender = "client" | "agent";

export interface SessionEvent {
	connectionId: string;
	createdAt: number;
	eventIndex: number;
	id: string;
	payload: Record<string, unknown>;
	sender: SessionEventSender;
	sessionId: string;
}
