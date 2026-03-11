import { api } from "@corporation/backend/convex/_generated/api";
import { useMatch } from "@tanstack/react-router";
import { useLocalStorage } from "@uidotdev/usehooks";
import { useQuery } from "convex/react";
import { AgentPanel } from "@/components/agent-panel";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@/components/ui/resizable";
import { WorkspacePanel } from "@/components/workspace-panel/workspace-panel";
import { useSpaceActor } from "@/hooks/use-space-actor";

const WORKSPACE_PANEL_OPEN_KEY = "corporation:workspace-panel-open";

export function SpaceLayout() {
	const match = useMatch({ from: "/_authenticated/space_/$spaceSlug" });
	const { spaceSlug } = match.params;
	const activeSessionId: string | undefined = match.search.session;

	const space = useQuery(api.spaces.getBySlug, { slug: spaceSlug });
	const { actor, isBindingSynced } = useSpaceActor(spaceSlug, space);

	const [workspacePanelOpen, setWorkspacePanelOpen] = useLocalStorage(
		WORKSPACE_PANEL_OPEN_KEY,
		true
	);

	if (!workspacePanelOpen) {
		return (
			<AgentPanel
				activeSessionId={activeSessionId}
				actor={actor}
				isBindingSynced={isBindingSynced}
				onToggleWorkspacePanel={() => setWorkspacePanelOpen(true)}
				space={space}
				spaceSlug={spaceSlug}
				workspacePanelOpen={false}
			/>
		);
	}

	return (
		<ResizablePanelGroup orientation="horizontal">
			<ResizablePanel>
				<AgentPanel
					activeSessionId={activeSessionId}
					actor={actor}
					isBindingSynced={isBindingSynced}
					onToggleWorkspacePanel={() => setWorkspacePanelOpen(false)}
					space={space}
					spaceSlug={spaceSlug}
					workspacePanelOpen={true}
				/>
			</ResizablePanel>
			<ResizableHandle />
			<ResizablePanel>
				<WorkspacePanel
					actor={actor}
					onClose={() => setWorkspacePanelOpen(false)}
					space={space}
					spaceSlug={spaceSlug}
				/>
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}
