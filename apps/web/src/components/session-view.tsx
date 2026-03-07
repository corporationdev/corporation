import { api } from "@corporation/backend/convex/_generated/api";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { nanoid } from "nanoid";
import { type FC, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentModelPicker } from "@/components/agent-model-picker";
import { ChatInput } from "@/components/chat/chat-input";
import { ChatMessages } from "@/components/chat/chat-messages";
import agentModelsData from "@/data/agent-models.json";
import { useSessionState } from "@/hooks/use-session-state";
import type { SpaceActor } from "@/lib/rivetkit";
import { usePendingMessageStore } from "@/stores/pending-message-store";

const INITIAL_AGENT = "claude";
const INITIAL_MODEL =
	agentModelsData[INITIAL_AGENT as keyof typeof agentModelsData].defaultModel ??
	"";

export const SessionView: FC<{
	actor: SpaceActor;
	sessionId?: string;
	spaceSlug: string;
}> = ({ actor, sessionId, spaceSlug }) => {
	if (sessionId) {
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

const NewSessionView: FC<{ spaceSlug: string }> = ({ spaceSlug }) => {
	const navigate = useNavigate();
	const setMessageStore = usePendingMessageStore((s) => s.setMessage);
	const [message, setMessage] = useState("");
	const [agent, setAgent] = useState(INITIAL_AGENT);
	const [modelId, setModelId] = useState(INITIAL_MODEL);

	const handleSend = useCallback(() => {
		const text = message.trim();
		if (!text) {
			return;
		}

		const sessionId = nanoid();

		setMessageStore({ text, agent, modelId });
		setMessage("");

		navigate({
			to: "/space/$spaceSlug",
			params: { spaceSlug },
			search: { session: sessionId },
		});
	}, [message, agent, modelId, setMessageStore, spaceSlug, navigate]);

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
				footer={
					<AgentModelPicker
						agent={agent}
						modelId={modelId}
						onAgentChange={setAgent}
						onModelIdChange={setModelId}
					/>
				}
				message={message}
				onMessageChange={setMessage}
				onSendMessage={handleSend}
				placeholder="Send a message..."
			/>
		</div>
	);
};

export const ConnectedSessionView: FC<{
	sessionId: string;
	spaceSlug: string;
	actor: SpaceActor;
}> = ({ sessionId, spaceSlug, actor }) => {
	const [message, setMessage] = useState("");
	const [agentOverride, setAgentOverride] = useState<string | null>(null);
	const [modelIdOverride, setModelIdOverride] = useState<string | null>(null);

	const messagesEndRef = useRef<HTMLDivElement>(null);
	const consumeMessage = usePendingMessageStore((s) => s.consumeMessage);
	const ensureSpace = useMutation(api.spaces.ensure);
	const touchSpace = useMutation(api.spaces.touch);
	const space = useQuery(api.spaces.getBySlug, { slug: spaceSlug });
	const sessionState = useSessionState({ sessionId, spaceSlug, actor });
	const agent = agentOverride ?? sessionState.agent ?? INITIAL_AGENT;
	const modelId = modelIdOverride ?? sessionState.modelId ?? INITIAL_MODEL;
	const isRunning = sessionState.status === "running";

	const pendingRef = useRef<{
		text: string;
		agent: string;
		modelId: string;
	} | null>(null);
	const sentRef = useRef(false);

	// Consume pending message from store on mount
	useEffect(() => {
		if (sentRef.current) {
			return;
		}
		const pending = consumeMessage();
		if (pending) {
			pendingRef.current = {
				...pending,
			};
			setAgentOverride(pending.agent);
			setModelIdOverride(pending.modelId);
		}
	}, [consumeMessage]);

	// Send pending message once actor is connected and space has agentUrl
	useEffect(() => {
		if (sentRef.current) {
			return;
		}
		const pending = pendingRef.current;
		if (!pending) {
			return;
		}
		if (actor.connStatus !== "connected" || !actor.connection) {
			return;
		}
		if (!space?.agentUrl) {
			return;
		}

		pendingRef.current = null;
		sentRef.current = true;

		const conn = actor.connection;
		if (space?._id) {
			touchSpace({ id: space._id }).catch(() => undefined);
		}
		conn
			.sendMessage(sessionId, pending.text, pending.agent, pending.modelId)
			.catch((error: unknown) => {
				console.error("Failed to send pending message", error);
				toast.error("Failed to send message");
			});
	}, [
		actor.connStatus,
		actor.connection,
		sessionId,
		space?.agentUrl,
		space?._id,
		touchSpace,
	]);

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

			await conn.sendMessage(sessionId, text, agent, modelId);
			if (space?._id) {
				touchSpace({ id: space._id }).catch(() => undefined);
			}
		} catch (error) {
			console.error("Failed to send message", { error, sessionId });
			setMessage((current) => (current ? current : text));
			toast.error("Failed to send message");
		}
	}, [
		message,
		ensureSpace,
		spaceSlug,
		actor.connection,
		sessionId,
		agent,
		modelId,
		space?._id,
		touchSpace,
	]);

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
			{sessionState.entries.length === 0 ? (
				<div className="flex flex-1 flex-col items-center justify-center px-4">
					<h1 className="font-semibold text-2xl">Ready to Chat</h1>
					<p className="mt-1 text-muted-foreground">
						Send a message to start a conversation.
					</p>
				</div>
			) : (
				<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
					<ChatMessages
						entries={sessionState.entries}
						isThinking={isRunning}
						messagesEndRef={messagesEndRef}
					/>
				</div>
			)}
			<ChatInput
				disabled={actor.connStatus !== "connected" || !actor.connection}
				footer={
					<AgentModelPicker
						agent={agent}
						modelId={modelId}
						onAgentChange={setAgentOverride}
						onModelIdChange={setModelIdOverride}
					/>
				}
				isRunning={isRunning}
				message={message}
				onMessageChange={setMessage}
				onSendMessage={handleSend}
				onStop={handleStop}
				placeholder="Send a message..."
			/>
		</div>
	);
};
