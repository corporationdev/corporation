import { api } from "@corporation/backend/convex/_generated/api";
import { useMatch } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { AgentPanel } from "@/components/agent-panel";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@/components/ui/resizable";
import { WorkspacePanel } from "@/components/workspace-panel/workspace-panel";
import { useAutoStartSandbox } from "@/hooks/use-auto-start-sandbox";
import { useSpaceActor } from "@/hooks/use-space-actor";

export function SpaceLayout() {
	const match = useMatch({ from: "/_authenticated/space_/$spaceSlug" });
	const { spaceSlug } = match.params;
	const activeSessionId: string | undefined = match.search.session;

	const space = useQuery(api.spaces.getBySlug, { slug: spaceSlug });

	useAutoStartSandbox(spaceSlug, space?.status);

	const { actor } = useSpaceActor(spaceSlug, space);

	return (
		<ResizablePanelGroup orientation="horizontal">
			<ResizablePanel>
				<AgentPanel
					activeSessionId={activeSessionId}
					actor={actor}
					space={space}
					spaceSlug={spaceSlug}
				/>
			</ResizablePanel>
			<ResizableHandle />
			<ResizablePanel>
				<WorkspacePanel actor={actor} space={space} spaceSlug={spaceSlug} />
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}
