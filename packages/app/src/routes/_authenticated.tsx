import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import type { Session, User } from "better-auth";

import { SidebarProvider } from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";

export type AuthenticatedContext = {
	session: { user: User; session: Session };
};

export const Route = createFileRoute("/_authenticated")({
	beforeLoad: async (): Promise<AuthenticatedContext> => {
		const session = await authClient.getSession();
		if (!session.data) {
			throw redirect({ to: "/login" });
		}

		return { session: session.data };
	},
	component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
	return (
		<SidebarProvider className="h-full overflow-hidden">
			<Outlet />
		</SidebarProvider>
	);
}
