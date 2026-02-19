import { useRouteContext } from "@tanstack/react-router";

import type { AuthenticatedContext } from "@/routes/_authenticated";

export function useAuthedSession(): AuthenticatedContext["session"] {
	const context = useRouteContext({ from: "/_authenticated" });
	return context.session;
}
