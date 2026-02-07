import { createFileRoute } from "@tanstack/react-router";

import SignUpForm from "@/components/sign-up-form";

export const Route = createFileRoute("/_public/signup")({
	component: RouteComponent,
});

function RouteComponent() {
	return <SignUpForm />;
}
