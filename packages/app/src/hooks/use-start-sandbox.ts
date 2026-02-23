import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useMutation as useTanstackMutation } from "@tanstack/react-query";
import { useMutation } from "convex/react";

type UseStartSandboxOptions = {
	spaceId: Id<"spaces">;
	status: string;
};

export function useStartSandbox({ spaceId, status }: UseStartSandboxOptions) {
	const ensureSpace = useMutation(api.spaces.ensure);

	const startMutation = useTanstackMutation({
		mutationFn: () => ensureSpace({ spaceId }),
	});

	const isTransitioning = status === "creating" || status === "starting";
	const isStarted = status === "started";
	const isPending = startMutation.isPending;
	const isStarting = isPending || isTransitioning;
	const isStartDisabled = isStarting || isStarted;

	const startSandbox = () => {
		if (isStartDisabled) {
			return;
		}
		startMutation.mutate();
	};

	return {
		startSandbox,
		isPending,
		isStarting,
		isTransitioning,
		isStarted,
		isStartDisabled,
	};
}
