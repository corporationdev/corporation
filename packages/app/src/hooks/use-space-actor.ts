import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { getAuthToken } from "@/lib/api-client";
import { type SpaceConnection, useSpaceSocketClient } from "@/lib/space-client";

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

type ActiveSpaceConnection = NonNullable<SpaceConnection>;

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
	const { data: authToken } = useQuery({
		queryKey: ["space-auth-token"],
		queryFn: getAuthToken,
		enabled: isEnabled,
		retry: false,
	});
	const actor = useSpaceSocketClient(
		spaceSlug,
		authToken,
		isEnabled && !!authToken
	);
	const lastSyncedRef = useRef<{
		connection: ActiveSpaceConnection | null;
		signature: string | null;
	}>({
		connection: null,
		signature: null,
	});
	const [syncedBinding, setSyncedBinding] = useState<{
		connection: ActiveSpaceConnection | null;
		signature: string | null;
	}>({
		connection: null,
		signature: null,
	});

	const isConnected =
		isEnabled &&
		!!authToken &&
		actor.connStatus === "connected" &&
		!!actor.connection;
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

	return {
		actor,
		isSandboxReady,
		isConnected,
		isBindingSynced,
	};
}
