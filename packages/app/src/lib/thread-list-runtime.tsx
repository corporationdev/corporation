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
import { useActor } from "./rivetkit";

function extractText(message: AppendMessage): string {
	return message.content
		.filter(
			(part): part is { type: "text"; text: string } => part.type === "text"
		)
		.map((part) => part.text)
		.join("");
}

/**
 * Thin runtime at `/space` (no spaceSlug). On send: generates both slugs,
 * stores pending, navigates to `/space/$spaceSlug?session=$sessionSlug`.
 */
function NewSpaceRuntime({ children }: { children: ReactNode }) {
	const navigate = useNavigate();
	const setPending = usePendingMessageStore((s) => s.setPending);

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
			if (!firstEnv) {
				throw new Error("No repository or environment configured");
			}

			const text = extractText(message);
			const spaceSlug = nanoid();
			const sessionSlug = nanoid();

			setPending({ text, environmentId: firstEnv._id });

			navigate({
				to: "/space/$spaceSlug",
				params: { spaceSlug },
				search: { session: sessionSlug },
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

/**
 * Thin runtime at `/space/$spaceSlug` (no ?session param). On send: generates
 * session slug, stores pending, navigates to add ?session=$sessionSlug.
 */
function NewSessionRuntime({
	spaceSlug,
	children,
}: {
	spaceSlug: string;
	children: ReactNode;
}) {
	const navigate = useNavigate();
	const setPending = usePendingMessageStore((s) => s.setPending);

	const runtime = useExternalStoreRuntime({
		isRunning: false,
		messages: [] as ThreadMessageLike[],
		convertMessage: (message: ThreadMessageLike) => message,
		onNew: (message: AppendMessage) => {
			const text = extractText(message);
			const sessionSlug = nanoid();

			setPending({ text, spaceSlug });

			navigate({
				to: "/space/$spaceSlug",
				params: { spaceSlug },
				search: { session: sessionSlug },
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

/**
 * Full runtime at `/space/$spaceSlug?session=$sessionSlug`.
 * Handles all business logic: ensures space exists (creates if needed),
 * creates agent session, manages actor connection, permissions, and messages.
 */
function ConnectedThreadRuntime({
	sessionSlug,
	spaceSlug,
	children,
}: {
	sessionSlug: string;
	spaceSlug: string;
	children: ReactNode;
}) {
	const onPermissionEvent = usePermissionStore((s) => s.onPermissionEvent);
	const setReplyPermission = usePermissionStore((s) => s.setReplyPermission);
	const resetPermissions = usePermissionStore((s) => s.reset);
	const updateThread = useOptimisticUpdateThreadMutation();
	const consumePending = usePendingMessageStore((s) => s.consumePending);
	const createThread = useMutation(api.agentSessions.create);
	const ensureSpace = useMutation(api.spaces.ensure);

	const session = useQuery(api.agentSessions.getBySlug, {
		slug: sessionSlug,
	});

	// For new threads: consume pending → ensure space → create session.
	// The sandboxUrl arrives reactively via the session query once the
	// space reaches "started" state.
	const pendingTextRef = useRef<string | null>(null);
	const initMutation = useTanstackMutation({
		mutationFn: async (pending: {
			text: string;
			environmentId?: Id<"environments">;
			spaceSlug?: string;
		}) => {
			// Ensure space exists — either create new (environmentId) or
			// ensure existing is running (spaceSlug lookup)
			const spaceId = await ensureSpace({
				slug: spaceSlug,
				environmentId: pending.environmentId,
			});

			await createThread({
				slug: sessionSlug,
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
	const sandboxUrl = session?.space.sandboxUrl ?? null;

	const actor = useActor({
		name: "agent",
		key: [sessionSlug],
		createWithInput: sandboxUrl ? { sandboxUrl } : undefined,
		enabled: !!sandboxUrl,
	});

	const threadState = useThreadEventState({
		slug: sessionSlug,
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

			const text = extractText(message);

			await ensureSpace({ slug: spaceSlug });

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

export function ThreadListRuntimeProvider({
	children,
}: {
	children: ReactNode;
}) {
	const match = useMatch({
		from: "/_authenticated/space/$spaceSlug",
		shouldThrow: false,
	});

	const spaceSlug = match?.params.spaceSlug;
	const sessionSlug = (match?.search as { session?: string })?.session;

	// No spaceSlug → brand new space flow
	if (!spaceSlug) {
		return <NewSpaceRuntime>{children}</NewSpaceRuntime>;
	}

	// spaceSlug but no session → new session in existing space
	if (!sessionSlug) {
		return (
			<NewSessionRuntime key={spaceSlug} spaceSlug={spaceSlug}>
				{children}
			</NewSessionRuntime>
		);
	}

	// spaceSlug + session → connected thread
	return (
		<ConnectedThreadRuntime
			key={sessionSlug}
			sessionSlug={sessionSlug}
			spaceSlug={spaceSlug}
		>
			{children}
		</ConnectedThreadRuntime>
	);
}
