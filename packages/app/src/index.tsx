import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { env } from "@corporation/env/web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { ConvexReactClient } from "convex/react";

import Loader from "@/components/loader";
import { authClient } from "@/lib/auth-client";
import { initAdapters } from "@/stores/adapter-store";
import { routeTree } from "./routeTree.gen";

const convex = new ConvexReactClient(env.VITE_CONVEX_URL);
const queryClient = new QueryClient();

const router = createRouter({
	routeTree,
	defaultPreload: "intent",
	defaultPendingComponent: () => <Loader />,
	context: {},
	Wrap({ children }: { children: React.ReactNode }) {
		return (
			<QueryClientProvider client={queryClient}>
				<ConvexBetterAuthProvider authClient={authClient} client={convex}>
					{children}
				</ConvexBetterAuthProvider>
			</QueryClientProvider>
		);
	},
});

declare module "@tanstack/react-router" {
	// biome-ignore lint/style/useConsistentTypeDefinitions: declaration merging requires interface
	interface Register {
		router: typeof router;
	}
}

export type { PlatformAdapters } from "@/stores/adapter-store";

export function App({
	adapters,
}: {
	adapters: import("@/stores/adapter-store").PlatformAdapters;
}) {
	initAdapters(adapters);
	return <RouterProvider router={router} />;
}
