import {
	type AppendMessage,
	AssistantRuntimeProvider,
	useExternalStoreRuntime,
} from "@assistant-ui/react";
import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { env } from "@corporation/env/web";
import { useMatch } from "@tanstack/react-router";
import { useAgent } from "agents/react";
import { useMutation } from "convex/react";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import type { UniversalEvent } from "sandbox-agent";

import { convertEventsToMessages } from "./convert-events";

const SERVER_URL = env.VITE_SERVER_URL;
const NEW_CHAT_ID = "new";

function ThreadRuntime({
	threadId,
	children,
}: {
	threadId: string;
	children: ReactNode;
}) {
	const [events, setEvents] = useState<UniversalEvent[]>([]);
	const touchThread = useMutation(api.agentSessions.touch);

	const agent = useAgent({
		agent: "sandbox-agent",
		name: threadId,
		host: SERVER_URL,
		onMessage: (event) => {
			try {
				const data = JSON.parse(event.data);
				if (data.type === "event") {
					setEvents((prev) => [...prev, data.data as UniversalEvent]);
				}
			} catch {
				// Ignore parse errors
			}
		},
	});

	const sendMessage = useCallback(
		async (content: string) => {
			if (threadId === NEW_CHAT_ID) {
				return;
			}
			await touchThread({
				id: threadId as Id<"agentSessions">,
			});
      agent?.send(JSON.stringify({ type: "send_message", content }));
		},
		[agent, threadId, touchThread]
	);

	const { messages, isRunning } = useMemo(
		() => convertEventsToMessages(events),
		[events]
	);

	const runtime = useExternalStoreRuntime({
		isRunning,
		messages,
		convertMessage: (message) => message,
		onNew: async (message: AppendMessage) => {
			if (threadId === NEW_CHAT_ID) {
				return;
			}
			const text = message.content
				.filter(
					(part): part is { type: "text"; text: string } => part.type === "text"
				)
				.map((part) => part.text)
				.join("");
			await sendMessage(text);
		},
	});

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			{children}
		</AssistantRuntimeProvider>
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
