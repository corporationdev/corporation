import {
	type AppendMessage,
	AssistantRuntimeProvider,
	useExternalStoreRuntime,
} from "@assistant-ui/react";
import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { env } from "@corporation/env/web";
import type {
	SandboxAgentMethods,
	SandboxState,
} from "@corporation/server/agent-types";
import { useMatch } from "@tanstack/react-router";
import { useAgent } from "agents/react";
import { useMutation } from "convex/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import type { PermissionEventData, UniversalEvent } from "sandbox-agent";
import { usePermissionStore } from "@/stores/permission-store";
import { useSandboxStore } from "@/stores/sandbox-store";

import { convertEventsToMessages } from "./convert-events";

const SERVER_URL = env.VITE_SERVER_URL;
const NEW_CHAT_ID = "new";

function processPermissionEvents(
	events: UniversalEvent[],
	offset: number,
	onPermissionEvent: (
		type: "permission.requested" | "permission.resolved",
		data: PermissionEventData
	) => void
): number {
	for (let i = offset; i < events.length; i++) {
		const event = events[i];
		if (
			event.type === "permission.requested" ||
			event.type === "permission.resolved"
		) {
			onPermissionEvent(event.type, event.data as PermissionEventData);
		}
	}
	return events.length;
}

function ThreadRuntime({
	threadId,
	children,
}: {
	threadId: string;
	children: ReactNode;
}) {
	const events = useSandboxStore((s) => s.events);
	const setSandboxState = useSandboxStore((s) => s.setSandboxState);
	const resetSandbox = useSandboxStore((s) => s.reset);
	const onPermissionEvent = usePermissionStore((s) => s.onPermissionEvent);
	const setReplyPermission = usePermissionStore((s) => s.setReplyPermission);
	const resetPermissions = usePermissionStore((s) => s.reset);
	const touchThread = useMutation(api.agentSessions.touch);
	const eventOffsetRef = useRef(0);

	const handleStateUpdate = useCallback(
		(state: SandboxState) => {
			eventOffsetRef.current = processPermissionEvents(
				state.events,
				eventOffsetRef.current,
				onPermissionEvent
			);
			setSandboxState(state);
		},
		[setSandboxState, onPermissionEvent]
	);

	const agent = useAgent<SandboxAgentMethods, SandboxState>({
		agent: "sandbox-agent",
		name: threadId,
		host: SERVER_URL,
		onStateUpdate: handleStateUpdate,
	});

	useEffect(() => {
		if (agent) {
			setReplyPermission((permissionId, reply) =>
				agent.stub.replyPermission(permissionId, reply)
			);
		}
		return () => {
			setReplyPermission(null);
			resetSandbox();
			resetPermissions();
		};
	}, [agent, setReplyPermission, resetSandbox, resetPermissions]);

	const sendMessage = useCallback(
		async (content: string) => {
			if (threadId === NEW_CHAT_ID) {
				return;
			}
			await touchThread({
				id: threadId as Id<"agentSessions">,
			});
			await agent?.stub.sendMessage(content);
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
