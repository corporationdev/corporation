import { api } from "@corporation/backend/convex/_generated/api";
import { useMutation } from "convex/react";
import { useMemo } from "react";

export function useOptimisticUpdateThreadMutation() {
	const updateThread = useMutation(api.agentSessions.update);

	return useMemo(
		() =>
			updateThread.withOptimisticUpdate((localStore, args) => {
				const currentSessions = localStore.getQuery(
					api.agentSessions.listAll,
					{}
				);
				if (!currentSessions) {
					return;
				}

				const updatedAt = Date.now();
				const nextSessions = [...currentSessions]
					.map((session) =>
						session._id === args.id
							? {
									...session,
									title: args.title ?? session.title,
									archivedAt: args.archivedAt ?? session.archivedAt,
									updatedAt,
								}
							: session
					)
					.sort((a, b) => b.updatedAt - a.updatedAt);

				localStore.setQuery(api.agentSessions.listAll, {}, nextSessions);
			}),
		[updateThread]
	);
}

export function useOptimisticDeleteThreadMutation() {
	const deleteThread = useMutation(api.agentSessions.remove);

	return useMemo(
		() =>
			deleteThread.withOptimisticUpdate((localStore, args) => {
				const currentSessions = localStore.getQuery(
					api.agentSessions.listAll,
					{}
				);
				if (!currentSessions) {
					return;
				}

				const nextSessions = currentSessions.filter(
					(session) => session._id !== args.id
				);
				localStore.setQuery(api.agentSessions.listAll, {}, nextSessions);
			}),
		[deleteThread]
	);
}

export function useOptimisticTouchThreadMutation() {
	const touchThread = useMutation(api.agentSessions.touch);

	return useMemo(
		() =>
			touchThread.withOptimisticUpdate((localStore, args) => {
				const currentSessions = localStore.getQuery(
					api.agentSessions.listAll,
					{}
				);
				if (!currentSessions) {
					return;
				}

				const updatedAt = Date.now();
				const nextSessions = [...currentSessions]
					.map((session) =>
						session._id === args.id
							? { ...session, archivedAt: null, updatedAt }
							: session
					)
					.sort((a, b) => b.updatedAt - a.updatedAt);
				localStore.setQuery(api.agentSessions.listAll, {}, nextSessions);
			}),
		[touchThread]
	);
}
