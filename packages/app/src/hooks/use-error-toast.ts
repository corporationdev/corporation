import { useEffect, useRef } from "react";
import { toast } from "sonner";

/**
 * Toasts an error when it transitions from falsy to a string value,
 * then calls `clearError` to reset it. Useful for consuming errors
 * written to Convex documents by fire-and-forget actions.
 */
export function useErrorToast(
	error: string | null | undefined,
	clearError: () => void
): void {
	const prev = useRef(error);

	useEffect(() => {
		if (error && !prev.current) {
			toast.error(error);
			clearError();
		}
		prev.current = error;
	}, [error, clearError]);
}
