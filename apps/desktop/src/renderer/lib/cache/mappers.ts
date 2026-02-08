import type { AgentSession } from "../../../shared/ipc-api";

type ConvexAgentSession = {
	_id: string;
	_creationTime: number;
	title: string;
	userId: string;
	createdAt: number;
	updatedAt: number;
	archivedAt: number | null;
};

export function convexSessionToLocal(
	session: ConvexAgentSession
): AgentSession {
	return {
		id: session._id,
		title: session.title,
		userId: session.userId,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		archivedAt: session.archivedAt,
	};
}
