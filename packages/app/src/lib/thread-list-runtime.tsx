import {
	type AppendMessage,
	AssistantRuntimeProvider,
	type ThreadMessageLike,
	useExternalStoreRuntime,
} from "@assistant-ui/react";
import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useMutation as useTanstackMutation } from "@tanstack/react-query";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { nanoid } from "nanoid";
import { type ReactNode, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useOptimisticUpdateThreadMutation } from "@/hooks/agent-session-mutations";
import { useThreadEventState } from "@/hooks/use-thread-event-state";
import { usePendingMessageStore } from "@/stores/pending-message-store";
import { usePermissionStore } from "@/stores/permission-store";
import { useSpaceSelectionStore } from "@/stores/space-selection-store";
import { useActor } from "./rivetkit";

const NEW_CHAT_ID = "new";

function NewThreadRuntime({ children }: { children: ReactNode }) {
	const navigate = useNavigate();
	const setPending = usePendingMessageStore((s) => s.setPending);
	const selectedSpaceId = useSpaceSelectionStore((s) => s.selectedSpaceId);

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
				selectedSpaceId: selectedSpaceId ?? undefined,
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

function ConnectedThreadRuntime({
	slug,
	children,
}: {
	slug: string;
	children: ReactNode;
}) {
	const onPermissionEvent = usePermissionStore((s) => s.onPermissionEvent);
	const setReplyPermission = usePermissionStore((s) => s.setReplyPermission);
	const resetPermissions = usePermissionStore((s) => s.reset);
	const updateThread = useOptimisticUpdateThreadMutation();
	const consumePending = usePendingMessageStore((s) => s.consumePending);
	const createThread = useMutation(api.agentSessions.create);
	const ensureSpace = useMutation(api.spaces.ensure);

	const session = useQuery(api.agentSessions.getBySlug, { slug });

	// For new threads: consume pending → ensure space → create session.
	// The sandboxUrl arrives reactively via the session query once the
	// space reaches "started" state.
	const pendingTextRef = useRef<string | null>(null);
	const initMutation = useTanstackMutation({
		mutationFn: async (pending: {
			text: string;
			environmentId: Id<"environments">;
			selectedSpaceId?: Id<"spaces">;
		}) => {
			const spaceId = await ensureSpace({
				environmentId: pending.environmentId,
				spaceId: pending.selectedSpaceId,
			});

			await createThread({
				slug,
				title: "New Chat",
				spaceId,
			});

			pendingTextRef.current = pending.text;
		},
		onError: (error) => {
			toast.error("Failed to start chat");
			console.error("initMutation failed", error);
		},
	});

	// Trigger init when pending message exists and session doesn't yet
	useEffect(() => {
		if (session !== null || initMutation.isPending || initMutation.isSuccess) {
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
		initMutation.isSuccess,
		consumePending,
		initMutation.mutate,
	]);

	// sandboxUrl arrives reactively via session once the space is started.
	// For existing threads the session already has it.
	const sandboxUrl = session?.space.sandboxUrl ?? null;

	const actor = useActor({
		name: "agent",
		key: [slug],
		createWithInput: sandboxUrl ? { sandboxUrl } : undefined,
		enabled: !!sandboxUrl,
	});

	const threadState = useThreadEventState({
		slug,
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

		actor.connection.postMessage(text).catch((error) => {
			console.error("Failed to send pending message", error);
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

			await ensureSpace({ spaceId: session.spaceId });

			await updateThread({ id: session._id, archivedAt: null });
			await actor.connection?.postMessage(
				text,
				session.space.sandboxUrl ?? undefined
			);
		},
	});

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			{children}
		</AssistantRuntimeProvider>
	);
}

function ThreadRuntime({
	slug,
	children,
}: {
	slug: string;
	children: ReactNode;
}) {
	if (slug === NEW_CHAT_ID) {
		return <NewThreadRuntime>{children}</NewThreadRuntime>;
	}
	return (
		<ConnectedThreadRuntime slug={slug}>{children}</ConnectedThreadRuntime>
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
	const slug = match?.params.slug ?? NEW_CHAT_ID;

	return (
		<ThreadRuntime key={slug} slug={slug}>
			{children}
		</ThreadRuntime>
	);
}
