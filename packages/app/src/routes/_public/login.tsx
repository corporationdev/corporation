import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import SignInForm from "@/components/sign-in-form";

export const Route = createFileRoute("/_public/login")({
	component: RouteComponent,
});

const publicRoute = getRouteApi("/_public");

function RouteComponent() {
	const { redirect } = publicRoute.useSearch();
	return <SignInForm redirectTo={redirect} />;
}
