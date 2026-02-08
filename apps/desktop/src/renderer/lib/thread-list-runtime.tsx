import {
	type AppendMessage,
	AssistantRuntimeProvider,
	type ThreadMessageLike,
	useExternalStoreRuntime,
} from "@assistant-ui/react";
import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { env } from "@corporation/env/web";
import type {
	SandboxAgentMethods,
	SandboxState,
} from "@corporation/server/agent-types";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { useAgent } from "agents/react";
import { useMutation } from "convex/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { usePendingMessageStore } from "@/stores/pending-message-store";
import { usePermissionStore } from "@/stores/permission-store";
import { useSandboxStore } from "@/stores/sandbox-store";

import { type ItemState, processEvents } from "./convert-events";

const SERVER_URL = env.VITE_SERVER_URL;
const NEW_CHAT_ID = "new";

function ThreadRuntime({
	threadId,
	children,
}: {
	threadId: string;
	children: ReactNode;
}) {
	const isNewThread = threadId === NEW_CHAT_ID;

	const setSandboxState = useSandboxStore((s) => s.setSandboxState);
	const resetSandbox = useSandboxStore((s) => s.reset);
	const onPermissionEvent = usePermissionStore((s) => s.onPermissionEvent);
	const setReplyPermission = usePermissionStore((s) => s.setReplyPermission);
	const resetPermissions = usePermissionStore((s) => s.reset);
	const touchThread = useMutation(api.agentSessions.touch);
	const createThread = useMutation(api.agentSessions.create);
	const navigate = useNavigate();
	const setPendingMessage = usePendingMessageStore((s) => s.setPendingMessage);
	const consumePendingMessage = usePendingMessageStore(
		(s) => s.consumePendingMessage
	);

	const itemStatesRef = useRef(new Map<string, ItemState>());
	const offsetRef = useRef(0);
	const [threadState, setThreadState] = useState<{
		messages: ThreadMessageLike[];
		isRunning: boolean;
	}>({ messages: [], isRunning: false });

	const handleStateUpdate = useCallback(
		(state: SandboxState) => {
			const result = processEvents(
				state.events,
				itemStatesRef.current,
				offsetRef.current,
				onPermissionEvent
			);
			console.log("messages", result.messages);
			offsetRef.current = result.offset;
			setThreadState(result);
			setSandboxState(state);
		},
		[setSandboxState, onPermissionEvent]
	);

	const agent = useAgent<SandboxAgentMethods, SandboxState>({
		agent: "sandbox-agent",
		name: threadId,
		host: SERVER_URL,
		onStateUpdate: handleStateUpdate,
		enabled: !isNewThread,
	});

	useEffect(() => {
		if (agent && !isNewThread) {
			setReplyPermission((permissionId, reply) =>
				agent.stub.replyPermission(permissionId, reply)
			);
		}
		return () => {
			setReplyPermission(null);
			resetSandbox();
			resetPermissions();
			itemStatesRef.current = new Map();
			offsetRef.current = 0;
		};
	}, [agent, isNewThread, setReplyPermission, resetSandbox, resetPermissions]);

	// Drain pending message after navigating to a real thread
	useEffect(() => {
		if (isNewThread || !agent) {
			return;
		}

		const pending = consumePendingMessage();
		if (!pending) {
			return;
		}

		agent.ready.then(async () => {
			await touchThread({ id: threadId as Id<"agentSessions"> });
			await agent.stub.sendMessage(pending);
		});
	}, [agent, isNewThread, threadId, touchThread, consumePendingMessage]);

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

			if (isNewThread) {
				const newThreadId = await createThread({ title: "New Chat" });
				setPendingMessage(text);
				navigate({
					to: "/chat/$threadId",
					params: { threadId: newThreadId },
				});
				return;
			}

			await touchThread({ id: threadId as Id<"agentSessions"> });
			await agent?.stub.sendMessage(text);
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
