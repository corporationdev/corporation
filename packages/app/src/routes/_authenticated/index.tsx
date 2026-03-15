import type { UseChatHelpers } from "@ai-sdk/react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { api } from "@tendril/backend/convex/_generated/api";
import type { Id } from "@tendril/backend/convex/_generated/dataModel";
import { useLocalStorage } from "@uidotdev/usehooks";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AgentView } from "@/components/chat/agent-view";
import { SpaceListSidebar } from "@/components/space-list-sidebar";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import type { TendrilUIMessage } from "@/lib/tendril-ui-message";
import { usePendingMessageStore } from "@/stores/pending-message-store";

export const Route = createFileRoute("/_authenticated/")({
	component: AuthenticatedIndex,
});

type ProjectListItem = FunctionReturnType<typeof api.projects.list>[number];
type EnvironmentListItem = FunctionReturnType<
	typeof api.environments.list
>[number];

type BackingSelection =
	| { type: "sandbox" }
	| { type: "existing"; environmentId: Id<"environments"> };

const RECENT_PROJECT_STORAGE_KEY = "tendril:recent-project";
const SANDBOX_KEY = "sandbox";
const DEFAULT_AGENT_ID = "codex-acp";
const DEFAULT_MODEL_ID = "gpt-5.4";

function AuthenticatedIndex() {
	const navigate = useNavigate();
	const setMessage = usePendingMessageStore((s) => s.setMessage);
	const projects = useQuery(api.projects.list);
	const environments = useQuery(api.environments.list);
	const createSpace = useMutation(api.spaces.create);
	const [, setIsSubmitting] = useState(false);
	const [selectedProjectId, setSelectedProjectId] =
		useLocalStorage<Id<"projects"> | null>(RECENT_PROJECT_STORAGE_KEY, null);
	const [selectedEnvironmentKey, setSelectedEnvironmentKey] =
		useState(SANDBOX_KEY);

	useEffect(() => {
		if (!projects) {
			return;
		}

		if (projects.length === 0) {
			setSelectedProjectId(null);
			return;
		}

		setSelectedProjectId((current) => {
			if (current && projects.some((project) => project._id === current)) {
				return current;
			}

			return projects[0]?._id ?? null;
		});
	}, [projects, setSelectedProjectId]);

	// Reset to sandbox if selected environment disappears or disconnects
	useEffect(() => {
		if (selectedEnvironmentKey === SANDBOX_KEY) {
			return;
		}

		const env = (environments ?? []).find(
			(e) => e._id === selectedEnvironmentKey
		);
		if (!env || env.status !== "connected") {
			setSelectedEnvironmentKey(SANDBOX_KEY);
		}
	}, [environments, selectedEnvironmentKey]);

	const selectedProject = useMemo(() => {
		if (!(projects && selectedProjectId)) {
			return null;
		}
		return (
			projects.find((project) => project._id === selectedProjectId) ?? null
		);
	}, [projects, selectedProjectId]);

	const selectedBacking = useMemo<BackingSelection | null>(() => {
		if (selectedEnvironmentKey === SANDBOX_KEY) {
			return { type: "sandbox" };
		}

		const env = (environments ?? []).find(
			(e) => e._id === selectedEnvironmentKey && e.status === "connected"
		);
		return env ? { type: "existing", environmentId: env._id } : null;
	}, [environments, selectedEnvironmentKey]);

	const handleSend: UseChatHelpers<TendrilUIMessage>["sendMessage"] =
		useCallback(
			async (message) => {
				const text =
					message && "text" in message ? message.text?.trim() : undefined;
				const composer =
					message && "metadata" in message
						? message.metadata?.composer
						: undefined;
				const agent = composer?.agentId ?? DEFAULT_AGENT_ID;
				const modelId = composer?.modelId ?? DEFAULT_MODEL_ID;
				if (!(text && selectedProject && selectedBacking && agent && modelId)) {
					return;
				}

				setIsSubmitting(true);
				try {
					const spaceSlug = nanoid();
					const sessionId = nanoid();
					await createSpace({
						slug: spaceSlug,
						projectId: selectedProject._id,
						backing: selectedBacking,
					});

					setMessage({ text, agent, modelId });
					navigate({
						to: "/space/$spaceSlug",
						params: { spaceSlug },
						search: { session: sessionId },
					});
				} catch (error) {
					toast.error(
						error instanceof Error ? error.message : "Failed to create space"
					);
				} finally {
					setIsSubmitting(false);
				}
			},
			[createSpace, navigate, selectedBacking, selectedProject, setMessage]
		);

	return (
		<div className="flex h-full w-full overflow-hidden">
			<SpaceListSidebar />
			<SidebarInset className="min-h-0 overflow-hidden">
				<header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
					<SidebarTrigger />
				</header>

				<AgentView messages={[]} sendMessage={handleSend} status="ready" />
			</SidebarInset>
		</div>
	);
}
