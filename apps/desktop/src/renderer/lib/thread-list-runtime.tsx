import {
	type AppendMessage,
	AssistantRuntimeProvider,
	type ThreadMessageLike,
	useExternalStoreRuntime,
} from "@assistant-ui/react";
import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { env } from "@corporation/env/web";
import type { registry } from "@corporation/server/registry";
import { createRivetKit } from "@rivetkit/react";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { UniversalEvent } from "sandbox-agent";
import { useOptimisticTouchThreadMutation } from "@/lib/agent-session-mutations";
import {
	appendEventsToCache,
	getCachedEvents,
} from "@/lib/cache/cached-events";
import { usePendingMessageStore } from "@/stores/pending-message-store";
import { usePermissionStore } from "@/stores/permission-store";

import { type ItemState, processEvent } from "./convert-events";

const SERVER_URL = env.VITE_SERVER_URL;
const NEW_CHAT_ID = "new";

const { useActor } = createRivetKit<typeof registry>({
	endpoint: `${SERVER_URL}/api/rivet`,
	disableMetadataLookup: true,
	devtools: false,
});

function NewThreadRuntime({ children }: { children: ReactNode }) {
	const createThread = useMutation(api.agentSessions.create);
	const navigate = useNavigate();
	const setPendingMessage = usePendingMessageStore((s) => s.setPendingMessage);

	const runtime = useExternalStoreRuntime({
		isRunning: false,
		messages: [] as ThreadMessageLike[],
		convertMessage: (message: ThreadMessageLike) => message,
		onNew: async (message: AppendMessage) => {
			const text = message.content
				.filter(
					(part): part is { type: "text"; text: string } => part.type === "text"
				)
				.map((part) => part.text)
				.join("");

			const newThreadId = await createThread({ title: "New Chat" });
			setPendingMessage(text);
			navigate({
				to: "/chat/$threadId",
				params: { threadId: newThreadId },
			});
		},
	});

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			{children}
		</AssistantRuntimeProvider>
	);
}

function ConnectedThreadRuntime({
	threadId,
	children,
}: {
	threadId: string;
	children: ReactNode;
}) {
	const onPermissionEvent = usePermissionStore((s) => s.onPermissionEvent);
	const setReplyPermission = usePermissionStore((s) => s.setReplyPermission);
	const resetPermissions = usePermissionStore((s) => s.reset);
	const touchThread = useOptimisticTouchThreadMutation();
	const consumePendingMessage = usePendingMessageStore(
		(s) => s.consumePendingMessage
	);

	const itemStatesRef = useRef(new Map<string, ItemState>());
	const lastSequenceRef = useRef(0);
	const caughtUpRef = useRef(false);
	const bufferRef = useRef<UniversalEvent[]>([]);
	const [cacheHydrated, setCacheHydrated] = useState(false);
	const [threadState, setThreadState] = useState<{
		messages: ThreadMessageLike[];
		isRunning: boolean;
	}>({ messages: [], isRunning: false });

	const applyEvents = useCallback(
		(events: UniversalEvent[], persist: boolean) => {
			const newEvents: UniversalEvent[] = [];
			let lastResult: {
				messages: ThreadMessageLike[];
				isRunning: boolean;
			} | null = null;

			for (const event of events) {
				if (event.sequence <= lastSequenceRef.current) {
					continue;
				}

				lastResult = processEvent(
					event,
					itemStatesRef.current,
					onPermissionEvent
				);
				lastSequenceRef.current = event.sequence;
				newEvents.push(event);
			}

			if (lastResult) {
				setThreadState(lastResult);
			}

			if (persist && newEvents.length > 0) {
				appendEventsToCache(threadId, newEvents).catch(() => {
					// Ignore write failures; cache will be refreshed on next transcript sync.
				});
			}
		},
		[onPermissionEvent, threadId]
	);

	const actor = useActor({
		name: "sandboxAgent",
		key: [threadId],
	});

	useEffect(() => {
		let cancelled = false;
		setCacheHydrated(false);

		getCachedEvents(threadId)
			.then((cachedEvents) => {
				if (cancelled) {
					return;
				}
				applyEvents(cachedEvents, false);
			})
			.finally(() => {
				if (!cancelled) {
					setCacheHydrated(true);
				}
			});

		return () => {
			cancelled = true;
		};
	}, [threadId, applyEvents]);

	// On connect, fetch missed events then flush any buffered real-time events
	useEffect(() => {
		if (
			!cacheHydrated ||
			actor.connStatus !== "connected" ||
			!actor.connection
		) {
			return;
		}

		caughtUpRef.current = false;
		bufferRef.current = [];

		actor.connection
			.getTranscript(lastSequenceRef.current)
			.then((missedEvents) => {
				applyEvents(missedEvents as UniversalEvent[], true);
				// Flush buffered real-time events, skipping duplicates
				applyEvents(bufferRef.current, true);
				bufferRef.current = [];
				caughtUpRef.current = true;
			});
	}, [actor.connStatus, actor.connection, applyEvents, cacheHydrated]);

	// Real-time events — buffer during catch-up, process directly after
	actor.useEvent("agentEvent", (event) => {
		const typed = event as UniversalEvent;
		if (!caughtUpRef.current) {
			bufferRef.current.push(typed);
			return;
		}
		applyEvents([typed], true);
	});

	// Wire up permission replies
	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			return;
		}

		setReplyPermission(async (permissionId, reply) => {
			await actor.connection?.replyPermission(permissionId, reply);
		});

		return () => {
			setReplyPermission(null);
			resetPermissions();
			itemStatesRef.current = new Map();
			lastSequenceRef.current = 0;
			caughtUpRef.current = false;
			bufferRef.current = [];
		};
	}, [
		actor.connStatus,
		actor.connection,
		setReplyPermission,
		resetPermissions,
	]);

	// Drain pending message after navigating to a real thread
	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			return;
		}

		const pending = consumePendingMessage();
		if (!pending) {
			return;
		}

		touchThread({ id: threadId as Id<"agentSessions"> }).catch(() => {
			// Pending messages are best-effort and can be retried by the user on failure.
		});
		actor.connection.postMessage(pending).catch(() => {
			// Runtime stream stays connected; user can resend manually if needed.
		});
	}, [
		actor.connStatus,
		actor.connection,
		threadId,
		touchThread,
		consumePendingMessage,
	]);

	const runtime = useExternalStoreRuntime({
		isRunning: threadState.isRunning,
		messages: threadState.messages,
		convertMessage: (message) => message,
		onNew: async (message: AppendMessage) => {
			const text = message.content
				.filter(
					(part): part is { type: "text"; text: string } => part.type === "text"
				)
				.map((part) => part.text)
				.join("");

			await touchThread({ id: threadId as Id<"agentSessions"> });
			await actor.connection?.postMessage(text);
		},
	});

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			{children}
		</AssistantRuntimeProvider>
	);
}

function ThreadRuntime({
	threadId,
	children,
}: {
	threadId: string;
	children: ReactNode;
}) {
	if (threadId === NEW_CHAT_ID) {
		return <NewThreadRuntime>{children}</NewThreadRuntime>;
	}
	return (
		<ConnectedThreadRuntime threadId={threadId}>
			{children}
		</ConnectedThreadRuntime>
	);
}

export function ThreadListRuntimeProvider({
	children,
}: {
	children: ReactNode;
}) {
	const match = useMatch({
		from: "/_authenticated/chat/$threadId",
		shouldThrow: false,
	});
	const threadId = match?.params.threadId ?? NEW_CHAT_ID;

	return (
		<ThreadRuntime key={threadId} threadId={threadId}>
			{children}
		</ThreadRuntime>
	);
}
