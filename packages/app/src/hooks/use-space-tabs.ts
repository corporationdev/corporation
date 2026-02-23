import type { SpaceTab } from "@corporation/server/space";
import { useEffect, useState } from "react";
import type { SpaceActor } from "@/lib/rivetkit";

export function useSpaceTabs(actor: SpaceActor): SpaceTab[] {
	const [tabs, setTabs] = useState<SpaceTab[]>([]);

	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			return;
		}
		const fetchTabs = async () => {
			try {
				const result = await actor.connection?.listTabs();
				if (result) {
					setTabs(await result);
				}
			} catch (error: unknown) {
				console.error("Failed to fetch tabs", error);
			}
		};
		fetchTabs();
	}, [actor.connStatus, actor.connection]);

	actor.useEvent("tabs.changed", (event) => {
		setTabs(event as SpaceTab[]);
	});

	return tabs;
}
