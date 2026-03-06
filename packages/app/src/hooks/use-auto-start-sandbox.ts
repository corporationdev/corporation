import { api } from "@corporation/backend/convex/_generated/api";
import { useMutation } from "convex/react";
import { useEffect, useRef } from "react";

export function useAutoStartSandbox(
	spaceSlug: string,
	status: string | undefined
) {
	const ensureSpace = useMutation(api.spaces.ensure);
	const hasAutoStarted = useRef<string | null>(null);

	useEffect(() => {
		if (!status || status === "running" || status === "creating") {
			return;
		}
		if (hasAutoStarted.current === spaceSlug) {
			return;
		}
		hasAutoStarted.current = spaceSlug;
		ensureSpace({ slug: spaceSlug }).catch(() => {
			// Silently ignore — ensureSpace is idempotent
		});
	}, [status, spaceSlug, ensureSpace]);
}
