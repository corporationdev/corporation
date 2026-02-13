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
import { nanoid } from "nanoid";
import { type ReactNode, useEffect, useRef } from "react";
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
	const navigate = useNavigate();
	const setPending = usePendingMessageStore((s) => s.setPending);
	const selectedSandboxId = useSandboxSelectionStore(
		(s) => s.selectedSandboxId
	);

	const repositories = useQuery(api.repositories.list);
	const firstRepo = repositories?.[0];
	const environments = useQuery(
		api.environments.listByRepository,
		firstRepo ? { repositoryId: firstRepo._id } : "skip"
	);
	const firstEnv = environments?.[0];

	const runtime = useExternalStoreRuntime({
		isRunning: false,
		messages: [] as ThreadMessageLike[],
		convertMessage: (message: ThreadMessageLike) => message,
		onNew: (message: AppendMessage) => {
			if (!(firstRepo && firstEnv)) {
				throw new Error("No repository or environment configured");
			}

			const text = message.content
				.filter(
					(part): part is { type: "text"; text: string } => part.type === "text"
				)
				.map((part) => part.text)
				.join("");

			const slug = nanoid();

			setPending({
				text,
				environmentId: firstEnv._id,
				repositoryId: firstRepo._id,
				selectedSandboxId: selectedSandboxId ?? undefined,
			});

			navigate({
				to: "/chat/$slug",
				params: { slug },
			});

			return Promise.resolve();
		},
	});

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			{children}
		</AssistantRuntimeProvider>
	);
}

async function callEnsureSandbox(args: {
	environmentId?: string;
	repositoryId?: string;
	sandboxId?: string;
}) {
	const res = await apiClient.sandboxes.ensure.$post({ json: args });
	if (!res.ok) {
		const data = await res.json();
		throw new Error(data.error);
	}
	return await res.json();
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
	const createThread = useMutation(api.agentSessions.create);

	const session = useQuery(api.agentSessions.getBySlug, { slug: threadId });

	// For new threads: consume pending → ensure sandbox → create session.
	// Stores the baseUrl and pending text for the actor to use once connected.
	const pendingTextRef = useRef<string | null>(null);
	const initMutation = useTanstackMutation({
		mutationFn: async (pending: {
			text: string;
			environmentId: string;
			repositoryId: string;
			selectedSandboxId?: string;
		}) => {
			const result = await callEnsureSandbox({
				environmentId: pending.environmentId,
				repositoryId: pending.repositoryId,
				sandboxId: pending.selectedSandboxId,
			});

			if (!result.baseUrl) {
				throw new Error("Expected baseUrl from ensure for new sandbox");
			}

			await createThread({
				slug: threadId,
				title: "New Chat",
				sandboxId: result.sandboxId as Id<"sandboxes">,
			});

			pendingTextRef.current = pending.text;
			return result.baseUrl;
		},
	});

	// Trigger init when pending message exists and session doesn't yet
	useEffect(() => {
		if (session !== null || initMutation.isPending || initMutation.data) {
			return;
		}

		const consumed = consumePending();
		if (!consumed) {
			return;
		}

		initMutation.mutate(consumed);
	}, [
		session,
		initMutation.isPending,
		initMutation.data,
		consumePending,
		initMutation.mutate,
	]);

	// baseUrl comes from init (new thread) — for existing threads the actor
	// already has it persisted in state.
	const baseUrl = initMutation.data;

	const actor = useActor({
		name: "sandboxAgent",
		key: [threadId],
		createWithInput: baseUrl ? { baseUrl } : undefined,
		enabled: !!baseUrl || !!session,
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

	// Send pending message once actor is connected
	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			return;
		}

		const text = pendingTextRef.current;
		if (!text) {
			return;
		}
		pendingTextRef.current = null;

		actor.connection.postMessage(text).catch(() => {
			// Runtime stream stays connected; user can resend manually if needed.
		});
	}, [actor.connStatus, actor.connection]);

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

			const result = await callEnsureSandbox({
				sandboxId: session.sandboxId,
			});

			await touchThread({ id: session._id });
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
		from: "/_authenticated/chat/$slug",
		shouldThrow: false,
	});
	const threadId = match?.params.slug ?? NEW_CHAT_ID;

	return (
		<ThreadRuntime key={threadId} threadId={threadId}>
			{children}
		</ThreadRuntime>
	);
}
