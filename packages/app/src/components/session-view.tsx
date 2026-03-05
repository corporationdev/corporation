import { api } from "@corporation/backend/convex/_generated/api";
import type { SessionTab } from "@corporation/server/space";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { ListIcon } from "lucide-react";
import { nanoid } from "nanoid";
import { type FC, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentModelPicker } from "@/components/agent-model-picker";
import { ChatInput } from "@/components/chat/chat-input";
import { ChatMessages } from "@/components/chat/chat-messages";
import { EventsView } from "@/components/events-view";
import { Button } from "@/components/ui/button";
import agentModelsData from "@/data/agent-models.json";
import { useSessionEventState } from "@/hooks/use-session-event-state";
import {
	isTransientActorConnError,
	softResetActorConnectionOnTransientError,
} from "@/lib/actor-errors";
import type { SpaceActor } from "@/lib/rivetkit";
import { serializeTab } from "@/lib/tab-routing";
import { usePendingMessageStore } from "@/stores/pending-message-store";

const INITIAL_AGENT = "claude";
const INITIAL_MODEL =
	agentModelsData[INITIAL_AGENT as keyof typeof agentModelsData].defaultModel ??
	"";

export const SessionView: FC<{
	actor: SpaceActor;
	sessionId?: string;
	sessionTab?: SessionTab;
	spaceSlug: string;
}> = ({ actor, sessionId, sessionTab, spaceSlug }) => {
	if (sessionId) {
		return (
			<ConnectedSessionView
				actor={actor}
				key={sessionId}
				sessionId={sessionId}
				sessionTab={sessionTab}
				spaceSlug={spaceSlug}
			/>
		);
	}

	return <NewSessionView actor={actor} key={spaceSlug} spaceSlug={spaceSlug} />;
};

type ConfigSelectOption = { value: string; name: string };
type ConfigOption = {
	category?: string;
	type?: string;
	currentValue?: string;
	options?:
		| ConfigSelectOption[]
		| Array<{ group: string; options: ConfigSelectOption[] }>;
};

function flattenSelectOptions(
	options:
		| ConfigSelectOption[]
		| Array<{ group: string; options: ConfigSelectOption[] }>
): ConfigSelectOption[] {
	if (options.length === 0) {
		return [];
	}
	if ("value" in options[0]) {
		return options as ConfigSelectOption[];
	}
	return (options as Array<{ options: ConfigSelectOption[] }>).flatMap(
		(g) => g.options
	);
}

function useAgentModels(actor: SpaceActor) {
	const [agentModels, setAgentModels] = useState<
		Record<string, { id: string; name?: string }[]> | undefined
	>();
	const [defaultModels, setDefaultModels] = useState<
		Record<string, string> | undefined
	>();

	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			return;
		}
		const conn = actor.connection;
		(async () => {
			const result = await conn.listAgents();
			const models: Record<string, { id: string; name?: string }[]> = {};
			const defaults: Record<string, string> = {};
			for (const agent of (
				result as {
					agents: Array<{ id: string; configOptions?: unknown[] | null }>;
				}
			).agents) {
				const options = (agent.configOptions ?? []) as ConfigOption[];
				for (const opt of options) {
					if (
						opt.category === "model" &&
						opt.type === "select" &&
						opt.options
					) {
						models[agent.id] = flattenSelectOptions(opt.options).map((o) => ({
							id: o.value,
							name: o.name,
						}));
					}
					if (
						opt.category === "model" &&
						opt.type === "select" &&
						opt.currentValue
					) {
						defaults[agent.id] = opt.currentValue;
					}
				}
			}
			setAgentModels(models);
			setDefaultModels(defaults);
		})().catch((error: unknown) => {
			if (isTransientActorConnError(error)) {
				return;
			}
			console.warn("Failed to load agent models", error);
		});
	}, [actor.connStatus, actor.connection]);

	return { agentModels, defaultModels };
}

const NewSessionView: FC<{ spaceSlug: string; actor: SpaceActor }> = ({
	spaceSlug,
	actor,
}) => {
	const navigate = useNavigate();
	const setMessageStore = usePendingMessageStore((s) => s.setMessage);
	const [message, setMessage] = useState("");
	const [agent, setAgent] = useState(INITIAL_AGENT);
	const [modelId, setModelId] = useState(INITIAL_MODEL);
	const { agentModels, defaultModels } = useAgentModels(actor);

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
			search: {
				tab: serializeTab({ type: "session", id: sessionId }),
			},
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
						agentModels={agentModels}
						defaultModels={defaultModels}
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
	sessionTab?: SessionTab;
	spaceSlug: string;
	actor: SpaceActor;
}> = ({ sessionId, sessionTab, spaceSlug, actor }) => {
	const [message, setMessage] = useState("");
	const [showEvents, setShowEvents] = useState(false);
	const [agentOverride, setAgentOverride] = useState<string | null>(null);
	const [modelIdOverride, setModelIdOverride] = useState<string | null>(null);
	const agent = agentOverride ?? sessionTab?.agent ?? INITIAL_AGENT;
	const modelId = modelIdOverride ?? sessionTab?.modelId ?? INITIAL_MODEL;

	const messagesEndRef = useRef<HTMLDivElement>(null);
	const consumeMessage = usePendingMessageStore((s) => s.consumeMessage);
	const ensureSpace = useMutation(api.spaces.ensure);
	const space = useQuery(api.spaces.getBySlug, { slug: spaceSlug });
	const { agentModels, defaultModels } = useAgentModels(actor);
	const sessionState = useSessionEventState({ sessionId, actor });
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
			pendingRef.current = pending;
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

		sessionState.setStatus("running");

		const conn = actor.connection;
		conn
			.sendMessage(sessionId, pending.text, pending.agent, pending.modelId)
			.catch((error: unknown) => {
				const kind = softResetActorConnectionOnTransientError({
					error,
					reasonPrefix: "session-pending-send",
					spaceSlug,
				});
				if (kind) {
					pendingRef.current = pending;
					sentRef.current = false;
					return;
				}
				console.error("Failed to send pending message", error);
				toast.error("Failed to send message");
			});
	}, [
		actor.connStatus,
		actor.connection,
		sessionId,
		space?.agentUrl,
		spaceSlug,
		sessionState,
	]);

	const handleSend = useCallback(async () => {
		const text = message.trim();
		if (!text) {
			return;
		}

		setMessage("");

		sessionState.setStatus("running");

		try {
			await ensureSpace({ slug: spaceSlug });

			const conn = actor.connection;
			if (!conn) {
				throw new Error("Actor connection is unavailable");
			}

			await conn.sendMessage(sessionId, text, agent, modelId);
		} catch (error) {
			const kind = softResetActorConnectionOnTransientError({
				error,
				reasonPrefix: "session-send",
				spaceSlug,
			});
			if (kind) {
				setMessage((current) => (current ? current : text));
				return;
			}
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
		sessionState,
	]);

	const handleStop = useCallback(async () => {
		try {
			// Optimistically update the status to idle
			sessionState.setStatus("idle");

			const conn = actor.connection;
			if (!conn) {
				return;
			}
			await conn.cancelSession(sessionId);
		} catch (error) {
			const kind = softResetActorConnectionOnTransientError({
				error,
				reasonPrefix: "session-cancel",
				spaceSlug,
			});
			if (kind) {
				return;
			}
			console.error("Failed to cancel session", { error, sessionId });
			toast.error("Failed to stop session");
		}
	}, [actor.connection, sessionId, spaceSlug, sessionState]);

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
						isThinking={isRunning}
						messagesEndRef={messagesEndRef}
					/>
				</div>
			)}
			{!showEvents && (
				<ChatInput
					disabled={actor.connStatus !== "connected" || !actor.connection}
					footer={
						<AgentModelPicker
							agent={agent}
							agentLocked
							agentModels={agentModels}
							defaultModels={defaultModels}
							modelId={modelId}
							modelLocked
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
			)}
		</div>
	);
};
