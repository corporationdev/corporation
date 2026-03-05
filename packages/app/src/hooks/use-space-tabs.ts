import type { SpaceTab } from "@corporation/server/space";
import { useEffect, useRef, useState } from "react";
import { softResetActorConnectionOnTransientError } from "@/lib/actor-errors";
import type { SpaceActor } from "@/lib/rivetkit";

function getActorSpaceSlug(actor: SpaceActor): string | undefined {
	const key = actor.opts.key;
	if (typeof key === "string") {
		return key;
	}
	return key[0];
}

function handleListTabsError(
	spaceSlug: string | undefined,
	error: unknown
): void {
	const kind = softResetActorConnectionOnTransientError({
		error,
		reasonPrefix: "space-tabs",
		spaceSlug,
	});
	if (kind) {
		return;
	}
	console.error("Failed to fetch tabs", error);
}

export function useSpaceTabs(actor: SpaceActor): SpaceTab[] {
	const [tabs, setTabs] = useState<SpaceTab[]>([]);
	const hasFetchedForCurrentConnection = useRef(false);
	const spaceSlug = getActorSpaceSlug(actor);

	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			hasFetchedForCurrentConnection.current = false;
			return;
		}

		if (hasFetchedForCurrentConnection.current) {
			return;
		}
		hasFetchedForCurrentConnection.current = true;

		const conn = actor.connection;
		let cancelled = false;

		const fetchTabs = async () => {
			try {
				const result = await conn.listTabs();
				if (!cancelled) {
					setTabs(result);
				}
			} catch (error: unknown) {
				handleListTabsError(spaceSlug, error);
			}
		};
		fetchTabs();
		return () => {
			cancelled = true;
		};
	}, [actor.connStatus, actor.connection, spaceSlug]);

	actor.useEvent("tabs.changed", (event) => {
		setTabs(event as SpaceTab[]);
	});

	return tabs;
}
