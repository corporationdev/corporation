import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import type { SessionTab } from "@corporation/server/space";
import { useMutation as useTanstackMutation } from "@tanstack/react-query";
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
	isDisposedConnError,
	isInFlightMismatchError,
	isTransientActorConnError,
	requestActorConnectionSoftReset,
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
	spaceSlug: string | undefined;
}> = ({ actor, sessionId, sessionTab, spaceSlug }) => {
	if (!spaceSlug) {
		return <NewSpaceView />;
	}

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

const NewSpaceView: FC = () => {
	const navigate = useNavigate();
	const setPending = usePendingMessageStore((s) => s.setPending);
	const [message, setMessage] = useState("");
	const [agent, setAgent] = useState(INITIAL_AGENT);
	const [modelId, setModelId] = useState(INITIAL_MODEL);

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

		setPending({ text, agent, modelId, environmentId: firstEnv._id });
		setMessage("");

		navigate({
			to: "/space/$spaceSlug",
			params: { spaceSlug },
			search: {
				tab: serializeTab({ type: "session", id: sessionId }),
			},
		});
	}, [message, firstEnv, agent, modelId, setPending, navigate]);

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
	const setPending = usePendingMessageStore((s) => s.setPending);
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

		setPending({ text, agent, modelId, spaceSlug });
		setMessage("");

		navigate({
			to: "/space/$spaceSlug",
			params: { spaceSlug },
			search: {
				tab: serializeTab({ type: "session", id: sessionId }),
			},
		});
	}, [message, agent, modelId, setPending, spaceSlug, navigate]);

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

const ConnectedSessionView: FC<{
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
	const consumePending = usePendingMessageStore((s) => s.consumePending);
	const ensureSpace = useMutation(api.spaces.ensure);
	const space = useQuery(api.spaces.getBySlug, { slug: spaceSlug });
	const { agentModels, defaultModels } = useAgentModels(actor);

	const pendingRef = useRef<{
		text: string;
		agent: string;
		modelId: string;
	} | null>(null);
	const initMutation = useTanstackMutation({
		mutationFn: async (pending: {
			text: string;
			agent: string;
			modelId: string;
			environmentId?: Id<"environments">;
		}) => {
			await ensureSpace({
				slug: spaceSlug,
				environmentId: pending.environmentId,
			});
			pendingRef.current = {
				text: pending.text,
				agent: pending.agent,
				modelId: pending.modelId,
			};
			setAgentOverride(pending.agent);
			setModelIdOverride(pending.modelId);
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

	// biome-ignore lint/correctness/useExhaustiveDependencies: initMutation.isSuccess is intentionally included to re-trigger this effect when the mutation completes, since it sets pendingRef (a ref that doesn't cause re-renders on its own).
	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			return;
		}

		if (!space?.agentUrl) {
			return;
		}

		const pending = pendingRef.current;
		if (!pending) {
			return;
		}
		pendingRef.current = null;

		const conn = actor.connection;
		conn
			.sendMessage(sessionId, pending.text, pending.agent, pending.modelId)
			.catch((error: unknown) => {
				if (isTransientActorConnError(error)) {
					if (isInFlightMismatchError(error)) {
						requestActorConnectionSoftReset(
							"session-pending-send-inflight-mismatch",
							spaceSlug
						);
					} else if (isDisposedConnError(error)) {
						requestActorConnectionSoftReset(
							"session-pending-send-disposed",
							spaceSlug
						);
					}
					pendingRef.current = pending;
					return;
				}
				console.error("Failed to send pending message", error);
				pendingRef.current = pending;
				toast.error("Failed to send message");
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

			await conn.sendMessage(sessionId, text, agent, modelId);
		} catch (error) {
			if (isTransientActorConnError(error)) {
				if (isInFlightMismatchError(error)) {
					requestActorConnectionSoftReset(
						"session-send-inflight-mismatch",
						spaceSlug
					);
				} else if (isDisposedConnError(error)) {
					requestActorConnectionSoftReset("session-send-disposed", spaceSlug);
				}
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
	]);

	const handleStop = useCallback(async () => {
		try {
			const conn = actor.connection;
			if (!conn) {
				return;
			}
			await conn.cancelSession(sessionId);
		} catch (error) {
			if (isTransientActorConnError(error)) {
				if (isInFlightMismatchError(error)) {
					requestActorConnectionSoftReset(
						"session-cancel-inflight-mismatch",
						spaceSlug
					);
				} else if (isDisposedConnError(error)) {
					requestActorConnectionSoftReset("session-cancel-disposed", spaceSlug);
				}
				return;
			}
			console.error("Failed to cancel session", { error, sessionId });
			toast.error("Failed to stop session");
		}
	}, [actor.connection, sessionId, spaceSlug]);

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
