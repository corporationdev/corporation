import { useEffect, useMemo, useRef, useState } from "react";
import { useActor } from "@/lib/rivetkit";

const KEEP_ALIVE_INTERVAL_MS = 300_000;

type SandboxBinding = {
	sandboxId: string;
	agentUrl: string;
};

type SpaceActorSpace =
	| {
			slug: string;
			status?: string;
			sandboxId?: string | null;
			agentUrl?: string | null;
	  }
	| null
	| undefined;

type SpaceConnection = NonNullable<ReturnType<typeof useActor>["connection"]>;

function getSandboxBinding(space: SpaceActorSpace): SandboxBinding | null {
	if (!(space?.sandboxId && space.agentUrl)) {
		return null;
	}

	return {
		sandboxId: space.sandboxId,
		agentUrl: space.agentUrl,
	};
}

function getBindingSignature(binding: SandboxBinding | null): string {
	if (!binding) {
		return "__unbound__";
	}

	return `${binding.sandboxId}::${binding.agentUrl}`;
}

export function useSpaceActor(
	spaceSlug: string | undefined,
	space: SpaceActorSpace,
	options?: { enabled?: boolean }
) {
	const binding = useMemo(() => getSandboxBinding(space), [space]);
	const bindingSignature = useMemo(
		() => getBindingSignature(binding),
		[binding]
	);
	const isSandboxReady = space?.status === "running" && !!binding;
	const isEnabled = (options?.enabled ?? true) && !!spaceSlug;
	const actor = useActor({
		name: "space",
		key: spaceSlug ? [spaceSlug] : ["__disconnected__"],
		enabled: isEnabled,
	});
	const lastSyncedRef = useRef<{
		connection: SpaceConnection | null;
		signature: string | null;
	}>({
		connection: null,
		signature: null,
	});
	const [syncedBinding, setSyncedBinding] = useState<{
		connection: SpaceConnection | null;
		signature: string | null;
	}>({
		connection: null,
		signature: null,
	});

	const isConnected =
		isEnabled && actor.connStatus === "connected" && !!actor.connection;
	const isBindingSynced =
		isConnected &&
		syncedBinding.connection === actor.connection &&
		syncedBinding.signature === bindingSignature;

	useEffect(() => {
		if (!(isConnected && actor.connection)) {
			lastSyncedRef.current = {
				connection: null,
				signature: null,
			};
			setSyncedBinding({
				connection: null,
				signature: null,
			});
			return;
		}

		const connection = actor.connection;
		const lastSynced = lastSyncedRef.current;
		if (
			lastSynced.connection === connection &&
			lastSynced.signature === bindingSignature
		) {
			return;
		}

		let cancelled = false;

		connection
			.syncSandboxBinding(binding)
			.then(() => {
				if (!cancelled) {
					lastSyncedRef.current = {
						connection,
						signature: bindingSignature,
					};
					setSyncedBinding({
						connection,
						signature: bindingSignature,
					});
				}
			})
			.catch((error) => {
				if (!cancelled) {
					console.error("Failed to sync sandbox binding", {
						error,
						spaceSlug,
					});
				}
			});

		return () => {
			cancelled = true;
		};
	}, [actor.connection, binding, bindingSignature, isConnected, spaceSlug]);

	useEffect(() => {
		if (!(isConnected && actor.connection && isSandboxReady)) {
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
	}, [actor.connection, isConnected, isSandboxReady]);

	return {
		actor,
		isSandboxReady,
		isConnected,
		isBindingSynced,
	};
}
