import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import SignUpForm from "@/components/sign-up-form";

export const Route = createFileRoute("/_public/signup")({
	component: RouteComponent,
});

const publicRoute = getRouteApi("/_public");

function RouteComponent() {
	const { redirect } = publicRoute.useSearch();
	return <SignUpForm redirectTo={redirect} />;
}
