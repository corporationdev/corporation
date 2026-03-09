import { useEffect, useMemo } from "react";
import { useActor } from "@/lib/rivetkit";

const KEEP_ALIVE_INTERVAL_MS = 300_000;

type SpaceActorSpace =
	| {
			slug: string;
			status?: string;
			sandboxId?: string;
			agentUrl?: string;
			workdir?: string;
	  }
	| null
	| undefined;

function getActorInput(space: SpaceActorSpace) {
	if (!(space?.slug && space.sandboxId && space.agentUrl && space.workdir)) {
		return null;
	}

	return {
		sandboxId: space.sandboxId,
		agentUrl: space.agentUrl,
		workdir: space.workdir,
	};
}

export function useSpaceActor(space: SpaceActorSpace) {
	const actorInput = useMemo(() => getActorInput(space), [space]);
	const actor = useActor({
		name: "space",
		key: [space?.slug ?? "__disconnected__"],
		createWithInput: actorInput ?? undefined,
		enabled: !!actorInput,
	});

	const isSandboxReady = !!actorInput;
	const isConnected =
		isSandboxReady && actor.connStatus === "connected" && !!actor.connection;

	useEffect(() => {
		if (!(isConnected && actor.connection)) {
			return;
		}

		let cancelled = false;

		const ping = async () => {
			try {
				await actor.connection?.keepAliveSandbox();
			} catch (error) {
				if (!cancelled) {
					console.error("Failed to keep sandbox alive", error);
				}
			}
		};

		ping();
		const intervalId = window.setInterval(() => {
			ping();
		}, KEEP_ALIVE_INTERVAL_MS);

		return () => {
			cancelled = true;
			window.clearInterval(intervalId);
		};
	}, [actor.connection, isConnected]);

	return {
		actor,
		isSandboxReady,
		isConnected,
	};
}
