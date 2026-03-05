import type { SpaceTab } from "@corporation/server/space";
import { useEffect, useState } from "react";
import { softResetActorConnectionOnTransientError } from "@/lib/actor-errors";
import type { SpaceActor } from "@/lib/rivetkit";

function getActorSpaceSlug(actor: SpaceActor): string | undefined {
	const key = actor.opts.key;
	if (typeof key === "string") {
		return key;
	}
	return key[0];
}

function handleListTabsError(actor: SpaceActor, error: unknown): void {
	const kind = softResetActorConnectionOnTransientError({
		error,
		reasonPrefix: "space-tabs",
		spaceSlug: getActorSpaceSlug(actor),
	});
	if (kind) {
		return;
	}
	console.error("Failed to fetch tabs", error);
}

export function useSpaceTabs(actor: SpaceActor): SpaceTab[] {
	const [tabs, setTabs] = useState<SpaceTab[]>([]);

	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			return;
		}
		const conn = actor.connection;

		const fetchTabs = async () => {
			try {
				const result = await conn.listTabs();
				setTabs(await result);
			} catch (error: unknown) {
				handleListTabsError(actor, error);
			}
		};
		fetchTabs();
	}, [actor, actor.connStatus, actor.connection, actor.opts.key]);

	actor.useEvent("tabs.changed", (event) => {
		setTabs(event as SpaceTab[]);
	});

	return tabs;
}
