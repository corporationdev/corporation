import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { authClient } from "@/lib/auth-client";
import { sanitizeAuthRedirectTarget } from "@/lib/auth-redirect";

export const Route = createFileRoute("/_public")({
	validateSearch: (search: Record<string, unknown>) => ({
		redirect:
			typeof search.redirect === "string"
				? sanitizeAuthRedirectTarget(search.redirect)
				: undefined,
	}),
	beforeLoad: async ({ search }) => {
		const session = await authClient.getSession();
		if (session.data?.user) {
			throw redirect({ to: search.redirect ?? "/" });
		}
	},
	component: () => <Outlet />,
});
