import { api } from "@corporation/backend/convex/_generated/api";
import { useMutation as useTanstackMutation } from "@tanstack/react-query";
import { useMutation } from "convex/react";

type UseStartSandboxOptions = {
	slug: string;
	status: string;
};

export function useStartSandbox({ slug, status }: UseStartSandboxOptions) {
	const ensureSpace = useMutation(api.spaces.ensure);

	const startMutation = useTanstackMutation({
		mutationFn: () => ensureSpace({ slug }),
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
