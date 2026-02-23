import type { SpaceTab } from "@corporation/server/space";
import { useEffect, useState } from "react";
import type { SpaceActor } from "@/lib/rivetkit";

export function useSpaceTabs(actor: SpaceActor): SpaceTab[] {
	const [tabs, setTabs] = useState<SpaceTab[]>([]);

	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			return;
		}
		actor.connection
			.listTabs()
			.then((nextTabs) => setTabs(nextTabs))
			.catch((error: unknown) => {
				console.error("Failed to fetch tabs", error);
			});
	}, [actor.connStatus, actor.connection]);

	actor.useEvent("tabs.changed", (event) => {
		setTabs(event as SpaceTab[]);
	});

	return tabs;
}
