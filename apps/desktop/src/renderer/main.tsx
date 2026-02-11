import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { env } from "@corporation/env/web";
import {
	focusManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { ConvexReactClient } from "convex/react";
import ReactDOM from "react-dom/client";

import { authClient } from "@/lib/auth-client";

import Loader from "./components/loader";
import { routeTree } from "./routeTree.gen";

const convex = new ConvexReactClient(env.VITE_CONVEX_URL);
const queryClient = new QueryClient();

focusManager.setEventListener((handleFocus) => {
	window.addEventListener("focus", () => handleFocus(true));
	window.addEventListener("blur", () => handleFocus(false));
	return () => {
		window.removeEventListener("focus", () => handleFocus(true));
		window.removeEventListener("blur", () => handleFocus(false));
	};
});

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

const rootElement = document.getElementById("app");

if (!rootElement) {
	throw new Error("Root element not found");
}

if (!rootElement.innerHTML) {
	const root = ReactDOM.createRoot(rootElement);
	root.render(<RouterProvider router={router} />);
}
