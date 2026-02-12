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
import { useMutation as useTanstackMutation } from "@tanstack/react-query";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { type ReactNode, useEffect } from "react";
import { useOptimisticTouchThreadMutation } from "@/hooks/agent-session-mutations";
import { useThreadEventState } from "@/hooks/use-thread-event-state";
import { apiClient } from "@/lib/api-client";
import { usePendingMessageStore } from "@/stores/pending-message-store";
import { usePermissionStore } from "@/stores/permission-store";
import { useSandboxSelectionStore } from "@/stores/sandbox-selection-store";

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
	const setPending = usePendingMessageStore((s) => s.setPending);

	const repositories = useQuery(api.repositories.list);
	const firstRepo = repositories?.[0];
	const environments = useQuery(
		api.environments.listByRepository,
		firstRepo ? { repositoryId: firstRepo._id } : "skip"
	);
	const firstEnv = environments?.[0];
	const selectedSandboxId = useSandboxSelectionStore(
		(s) => s.selectedSandboxId
	);

	const ensureSandboxMutation = useTanstackMutation({
		mutationFn: async (args: {
			environmentId?: string;
			repositoryId?: string;
			sandboxId?: string;
		}) => {
			const res = await apiClient.sandboxes.ensure.$post({
				json: args,
			});
			if (!res.ok) {
				const data = await res.json();
				throw new Error(data.error);
			}
			return await res.json();
		},
	});

	const runtime = useExternalStoreRuntime({
		isRunning: false,
		messages: [] as ThreadMessageLike[],
		convertMessage: (message: ThreadMessageLike) => message,
		onNew: async (message: AppendMessage) => {
			if (!(firstRepo && firstEnv)) {
				throw new Error("No repository or environment configured");
			}

			const text = message.content
				.filter(
					(part): part is { type: "text"; text: string } => part.type === "text"
				)
				.map((part) => part.text)
				.join("");

			const result = await ensureSandboxMutation.mutateAsync({
				environmentId: firstEnv._id,
				repositoryId: firstRepo._id,
				sandboxId: selectedSandboxId ?? undefined,
			});

			if (!result.baseUrl) {
				throw new Error("Expected baseUrl from ensure for new sandbox");
			}

			const newThreadId = await createThread({
				title: "New Chat",
				sandboxId: result.sandboxId as Id<"sandboxes">,
			});

			setPending({
				text,
				sandboxId: result.sandboxId,
				baseUrl: result.baseUrl,
			});
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
	const consumePending = usePendingMessageStore((s) => s.consumePending);
	const pending = usePendingMessageStore((s) => s.pending);

	const session = useQuery(api.agentSessions.getById, {
		id: threadId as Id<"agentSessions">,
	});

	const ensureSandboxMutation = useTanstackMutation({
		mutationFn: async (args: { sandboxId: string }) => {
			const res = await apiClient.sandboxes.ensure.$post({
				json: args,
			});
			if (!res.ok) {
				const data = await res.json();
				throw new Error(data.error);
			}
			return await res.json();
		},
	});

	const actor = useActor({
		name: "sandboxAgent",
		key: [threadId],
		createWithInput: pending?.baseUrl
			? { baseUrl: pending.baseUrl }
			: undefined,
	});

	const threadState = useThreadEventState({
		threadId,
		actor,
		onPermissionEvent,
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

		const consumed = consumePending();
		if (!consumed) {
			return;
		}

		touchThread({ id: threadId as Id<"agentSessions"> }).catch(() => {
			// Pending messages are best-effort and can be retried by the user on failure.
		});
		actor.connection.postMessage(consumed.text).catch(() => {
			// Runtime stream stays connected; user can resend manually if needed.
		});
	}, [
		actor.connStatus,
		actor.connection,
		threadId,
		touchThread,
		consumePending,
	]);

	const runtime = useExternalStoreRuntime({
		isRunning: threadState.isRunning,
		messages: threadState.messages,
		convertMessage: (message) => message,
		onNew: async (message: AppendMessage) => {
			if (!session) {
				throw new Error("Session not loaded");
			}

			const text = message.content
				.filter(
					(part): part is { type: "text"; text: string } => part.type === "text"
				)
				.map((part) => part.text)
				.join("");

			const result = await ensureSandboxMutation.mutateAsync({
				sandboxId: session.sandboxId,
			});

			await touchThread({ id: threadId as Id<"agentSessions"> });
			await actor.connection?.postMessage(text, result.baseUrl ?? undefined);
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
