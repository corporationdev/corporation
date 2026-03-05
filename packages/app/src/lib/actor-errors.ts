const SOFT_RESET_EVENT_NAME = "space.actor.soft-reset";

type SoftResetDetail = {
	reason: string;
	spaceSlug?: string;
};

function extractErrorText(error: unknown): string {
	if (error instanceof Error) {
		return `${error.name} ${error.message}`.toLowerCase();
	}

	if (typeof error === "string") {
		return error.toLowerCase();
	}

	if (error && typeof error === "object" && "message" in error) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string") {
			return message.toLowerCase();
		}
	}

	return "";
}

export function isDisposedConnError(error: unknown): boolean {
	const text = extractErrorText(error);
	return (
		text.includes("disposed actor connection") ||
		text.includes("actorconndisposed")
	);
}

export function isInFlightMismatchError(error: unknown): boolean {
	const text = extractErrorText(error);
	return (
		text.includes("no in flight response") ||
		text.includes("in-flight map lookup") ||
		text.includes("in flight response for")
	);
}

export function isTransientActorConnError(error: unknown): boolean {
	return isDisposedConnError(error) || isInFlightMismatchError(error);
}

export function requestActorConnectionSoftReset(
	reason: string,
	spaceSlug?: string
): void {
	if (typeof window === "undefined") {
		return;
	}

	window.dispatchEvent(
		new CustomEvent<SoftResetDetail>(SOFT_RESET_EVENT_NAME, {
			detail: { reason, spaceSlug },
		})
	);
}

export function addActorConnectionSoftResetListener(
	listener: (detail: SoftResetDetail) => void
): () => void {
	if (typeof window === "undefined") {
		return () => undefined;
	}

	const handler = (event: Event) => {
		const customEvent = event as CustomEvent<SoftResetDetail>;
		listener(customEvent.detail);
	};
	window.addEventListener(SOFT_RESET_EVENT_NAME, handler);
	return () => {
		window.removeEventListener(SOFT_RESET_EVENT_NAME, handler);
	};
}
