export function sanitizeAuthRedirectTarget(redirectTo?: string | null): string {
	if (!redirectTo) {
		return "/";
	}

	return redirectTo.startsWith("/") && !redirectTo.startsWith("//")
		? redirectTo
		: "/";
}
