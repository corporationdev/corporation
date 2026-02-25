import { api } from "@corporation/backend/convex/_generated/api";
import { useMutation } from "convex/react";

export function useStartSandbox(slug: string, status: string) {
	const ensureSpace = useMutation(api.spaces.ensure);

	const isStopped =
		status === "paused" || status === "killed" || status === "error";
	const isStarted = status === "running";
	const isTransitioning = status === "creating";

	const startSandbox = () => {
		if (!isStopped) {
			return;
		}
		ensureSpace({ slug });
	};

	return { startSandbox, isStopped, isStarted, isTransitioning };
}
