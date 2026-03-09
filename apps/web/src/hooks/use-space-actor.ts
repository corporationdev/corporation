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

function getActorKey(
	space: SpaceActorSpace,
	actorInput: ReturnType<typeof getActorInput>,
	enabled: boolean
) {
	if (!(enabled && space?.slug && actorInput?.sandboxId)) {
		return ["__disconnected__"];
	}

	return [space.slug, actorInput.sandboxId];
}

export function useSpaceActor(
	space: SpaceActorSpace,
	options?: { enabled?: boolean }
) {
	const actorInput = useMemo(() => getActorInput(space), [space]);
	const isSandboxReady = space?.status === "running" && !!actorInput;
	const isEnabled = (options?.enabled ?? true) && isSandboxReady;
	const actor = useActor({
		name: "space",
		key: getActorKey(space, actorInput, isEnabled),
		createWithInput: actorInput ?? undefined,
		enabled: isEnabled,
	});

	const isConnected =
		isEnabled && actor.connStatus === "connected" && !!actor.connection;

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
