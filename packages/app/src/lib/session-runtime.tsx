import {
	type AppendMessage,
	AssistantRuntimeProvider,
	type ThreadMessageLike,
	useExternalStoreRuntime,
} from "@assistant-ui/react";
import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useMutation as useTanstackMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { nanoid } from "nanoid";
import { type ReactNode, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useSessionEventState } from "@/hooks/use-session-event-state";
import type { SpaceActor } from "@/lib/rivetkit";
import { serializeTab } from "@/lib/tab-routing";
import { usePendingMessageStore } from "@/stores/pending-message-store";

function extractText(message: AppendMessage): string {
	return message.content
		.filter(
			(part): part is { type: "text"; text: string } => part.type === "text"
		)
		.map((part) => part.text)
		.join("");
}

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
			const sessionId = nanoid();

			setPending({ text, environmentId: firstEnv._id });

			navigate({
				to: "/space/$spaceSlug",
				params: { spaceSlug },
				search: {
					tab: serializeTab({ type: "session", id: sessionId }),
				},
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
			const sessionId = nanoid();

			setPending({ text, spaceSlug });

			navigate({
				to: "/space/$spaceSlug",
				params: { spaceSlug },
				search: {
					tab: serializeTab({ type: "session", id: sessionId }),
				},
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

function ConnectedSessionRuntime({
	sessionId,
	spaceSlug,
	actor,
	children,
}: {
	sessionId: string;
	spaceSlug: string;
	actor: SpaceActor;
	children: ReactNode;
}) {
	const consumePending = usePendingMessageStore((s) => s.consumePending);
	const ensureSpace = useMutation(api.spaces.ensure);

	const space = useQuery(api.spaces.getBySlug, { slug: spaceSlug });

	const pendingTextRef = useRef<string | null>(null);
	const initMutation = useTanstackMutation({
		mutationFn: async (pending: {
			text: string;
			environmentId?: Id<"environments">;
		}) => {
			await ensureSpace({
				slug: spaceSlug,
				environmentId: pending.environmentId,
			});
			pendingTextRef.current = pending.text;
		},
		onError: (error) => {
			toast.error("Failed to start chat");
			console.error("initMutation failed", error);
		},
	});

	useEffect(() => {
		if (initMutation.isPending || initMutation.isSuccess) {
			return;
		}

		const consumed = consumePending();
		if (!consumed) {
			return;
		}

		initMutation.mutate(consumed);
	}, [
		consumePending,
		initMutation.isPending,
		initMutation.isSuccess,
		initMutation.mutate,
	]);

	const sessionState = useSessionEventState({
		sessionId,
		actor,
	});

	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			return;
		}

		if (!space?.sandboxUrl) {
			return;
		}

		const text = pendingTextRef.current;
		if (!text) {
			return;
		}
		pendingTextRef.current = null;

		const conn = actor.connection;
		conn.sendMessage(sessionId, text).catch((error: unknown) => {
			console.error("Failed to send pending message", error);
		});
	}, [actor.connStatus, actor.connection, sessionId, space?.sandboxUrl]);

	const runtime = useExternalStoreRuntime({
		isRunning: sessionState.isRunning,
		messages: sessionState.messages,
		convertMessage: (message) => message,
		onNew: async (message: AppendMessage) => {
			const text = extractText(message);

			await ensureSpace({ slug: spaceSlug });

			const conn = actor.connection;
			if (!conn) {
				throw new Error("Actor connection is unavailable");
			}

			await conn.sendMessage(sessionId, text);
		},
	});

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			{children}
		</AssistantRuntimeProvider>
	);
}

export function SessionRuntimeProvider({
	sessionId,
	spaceSlug,
	actor,
	children,
}: {
	sessionId: string | undefined;
	spaceSlug: string | undefined;
	actor: SpaceActor | null;
	children: ReactNode;
}) {
	if (!spaceSlug) {
		return <NewSpaceRuntime>{children}</NewSpaceRuntime>;
	}

	if (sessionId && actor) {
		return (
			<ConnectedSessionRuntime
				actor={actor}
				key={sessionId}
				sessionId={sessionId}
				spaceSlug={spaceSlug}
			>
				{children}
			</ConnectedSessionRuntime>
		);
	}

	return (
		<NewSessionRuntime key={spaceSlug} spaceSlug={spaceSlug}>
			{children}
		</NewSessionRuntime>
	);
}
