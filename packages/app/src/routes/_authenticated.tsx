import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import type { Session, User } from "better-auth";
import { useConvexAuth } from "convex/react";

import Loader from "@/components/loader";
import { SidebarProvider } from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";
import { useLayoutStore } from "@/stores/layout-store";

export type AuthenticatedContext = {
	session: { user: User; session: Session };
};

export const Route = createFileRoute("/_authenticated")({
	beforeLoad: async (): Promise<AuthenticatedContext> => {
		const session = await authClient.getSession();
		if (!session.data?.user) {
			throw redirect({ to: "/login" });
		}

		return { session: session.data };
	},
	component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
	const { isLoading, isAuthenticated } = useConvexAuth();
	const leftOpen = useLayoutStore((s) => s.leftSidebarOpen);
	const setLeftOpen = useLayoutStore((s) => s.setLeftSidebarOpen);

	if (isLoading || !isAuthenticated) {
		return <Loader />;
	}

	return (
		<SidebarProvider
			className="h-full overflow-hidden"
			onOpenChange={setLeftOpen}
			open={leftOpen}
		>
			<Outlet />
		</SidebarProvider>
	);
}
