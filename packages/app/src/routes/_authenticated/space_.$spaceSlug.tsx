// biome-ignore-all lint/style/useFilenamingConvention: TanStack Router uses `$` for dynamic route params
import { createFileRoute } from "@tanstack/react-router";

import { AgentPanel } from "@/components/agent-panel";
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from "@/components/ui/resizable";

type SpaceSearchParams = {
	session?: string;
};

export const Route = createFileRoute("/_authenticated/space_/$spaceSlug")({
	component: SpaceWithIdRoute,
	validateSearch: (search: Record<string, unknown>): SpaceSearchParams => ({
		session: typeof search.session === "string" ? search.session : undefined,
	}),
});

function SpaceWithIdRoute() {
	return (
		<ResizablePanelGroup orientation="horizontal">
			<ResizablePanel>
				<AgentPanel />
			</ResizablePanel>
			<ResizableHandle />
			<ResizablePanel>Two</ResizablePanel>
		</ResizablePanelGroup>
	);
}
