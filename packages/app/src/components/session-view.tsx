import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useMutation as useTanstackMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { ListIcon } from "lucide-react";
import { nanoid } from "nanoid";
import { type FC, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ChatInput } from "@/components/chat/chat-input";
import { ChatMessages } from "@/components/chat/chat-messages";
import { EventsView } from "@/components/events-view";
import { Button } from "@/components/ui/button";
import { useSessionEventState } from "@/hooks/use-session-event-state";
import type { SpaceActor } from "@/lib/rivetkit";
import { serializeTab } from "@/lib/tab-routing";
import { usePendingMessageStore } from "@/stores/pending-message-store";

export const SessionView: FC<{
	actor: SpaceActor;
	sessionId: string | undefined;
	spaceSlug: string | undefined;
}> = ({ actor, sessionId, spaceSlug }) => {
	if (!spaceSlug) {
		return <NewSpaceView />;
	}

	if (sessionId && actor) {
		return (
			<ConnectedSessionView
				actor={actor}
				key={sessionId}
				sessionId={sessionId}
				spaceSlug={spaceSlug}
			/>
		);
	}

	return <NewSessionView key={spaceSlug} spaceSlug={spaceSlug} />;
};

const NewSpaceView: FC = () => {
	const navigate = useNavigate();
	const setPending = usePendingMessageStore((s) => s.setPending);
	const [message, setMessage] = useState("");

	const repositories = useQuery(api.repositories.list);
	const firstRepo = repositories?.[0];
	const environments = useQuery(
		api.environments.listByRepository,
		firstRepo ? { repositoryId: firstRepo._id } : "skip"
	);
	const firstEnv = environments?.[0];

	const handleSend = useCallback(() => {
		const text = message.trim();
		if (!(text && firstEnv)) {
			return;
		}

		const spaceSlug = nanoid();
		const sessionId = nanoid();

		setPending({ text, environmentId: firstEnv._id });
		setMessage("");

		navigate({
			to: "/space/$spaceSlug",
			params: { spaceSlug },
			search: {
				tab: serializeTab({ type: "session", id: sessionId }),
			},
		});
	}, [message, firstEnv, setPending, navigate]);

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			<div className="flex flex-1 flex-col items-center justify-center px-4">
				<h1 className="font-semibold text-2xl">Hello there!</h1>
				<p className="mt-1 text-muted-foreground text-xl">
					How can I help you today?
				</p>
			</div>
			<ChatInput
				disabled={!firstEnv}
				message={message}
				onMessageChange={setMessage}
				onSendMessage={handleSend}
				placeholder="Send a message..."
			/>
		</div>
	);
};

const NewSessionView: FC<{ spaceSlug: string }> = ({ spaceSlug }) => {
	const navigate = useNavigate();
	const setPending = usePendingMessageStore((s) => s.setPending);
	const [message, setMessage] = useState("");

	const handleSend = useCallback(() => {
		const text = message.trim();
		if (!text) {
			return;
		}

		const sessionId = nanoid();

		setPending({ text, spaceSlug });
		setMessage("");

		navigate({
			to: "/space/$spaceSlug",
			params: { spaceSlug },
			search: {
				tab: serializeTab({ type: "session", id: sessionId }),
			},
		});
	}, [message, setPending, spaceSlug, navigate]);

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			<div className="flex flex-1 flex-col items-center justify-center px-4">
				<h1 className="font-semibold text-2xl">Hello there!</h1>
				<p className="mt-1 text-muted-foreground text-xl">
					How can I help you today?
				</p>
			</div>
			<ChatInput
				disabled={false}
				message={message}
				onMessageChange={setMessage}
				onSendMessage={handleSend}
				placeholder="Send a message..."
			/>
		</div>
	);
};

const ConnectedSessionView: FC<{
	sessionId: string;
	spaceSlug: string;
	actor: SpaceActor;
}> = ({ sessionId, spaceSlug, actor }) => {
	const [message, setMessage] = useState("");
	const [showEvents, setShowEvents] = useState(false);
	const messagesEndRef = useRef<HTMLDivElement>(null);
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

	// biome-ignore lint/correctness/useExhaustiveDependencies: initMutation.isSuccess is intentionally included to re-trigger this effect when the mutation completes, since it sets pendingTextRef (a ref that doesn't cause re-renders on its own).
	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			return;
		}

		if (!space?.agentUrl) {
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
	}, [
		actor.connStatus,
		actor.connection,
		sessionId,
		space?.agentUrl,
		initMutation.isSuccess,
	]);

	const sessionState = useSessionEventState({ sessionId, actor });

	const handleSend = useCallback(async () => {
		const text = message.trim();
		if (!text) {
			return;
		}

		setMessage("");

		try {
			await ensureSpace({ slug: spaceSlug });

			const conn = actor.connection;
			if (!conn) {
				throw new Error("Actor connection is unavailable");
			}

			await conn.sendMessage(sessionId, text);
		} catch (error) {
			console.error("Failed to send message", { error, sessionId });
			setMessage((current) => (current ? current : text));
			toast.error("Failed to send message");
		}
	}, [message, ensureSpace, spaceSlug, actor.connection, sessionId]);

	const handleStop = useCallback(async () => {
		try {
			const conn = actor.connection;
			if (!conn) {
				return;
			}
			await conn.cancelSession(sessionId);
		} catch (error) {
			console.error("Failed to cancel session", { error, sessionId });
			toast.error("Failed to stop session");
		}
	}, [actor.connection, sessionId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally scroll when entries change
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [sessionState.entries]);

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-background">
			{showEvents ? (
				<EventsView
					events={sessionState.rawEvents}
					onBack={() => setShowEvents(false)}
				/>
			) : sessionState.entries.length === 0 ? (
				<div className="flex flex-1 flex-col items-center justify-center px-4">
					<h1 className="font-semibold text-2xl">Ready to Chat</h1>
					<p className="mt-1 text-muted-foreground">
						Send a message to start a conversation.
					</p>
				</div>
			) : (
				<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
					<Button
						className="absolute top-2 right-2 z-10"
						onClick={() => setShowEvents(true)}
						size="icon"
						title="Switch to events view"
						variant="ghost"
					>
						<ListIcon className="size-4" />
					</Button>
					<ChatMessages
						entries={sessionState.entries}
						isThinking={sessionState.isRunning}
						messagesEndRef={messagesEndRef}
					/>
				</div>
			)}
			{!showEvents && (
				<ChatInput
					disabled={actor.connStatus !== "connected" || !actor.connection}
					isRunning={sessionState.isRunning}
					message={message}
					onMessageChange={setMessage}
					onSendMessage={handleSend}
					onStop={handleStop}
					placeholder="Send a message..."
				/>
			)}
		</div>
	);
};
