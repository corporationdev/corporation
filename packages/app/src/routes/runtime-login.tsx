import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import Loader from "@/components/loader";
import SignInForm from "@/components/sign-in-form";
import { apiClient } from "@/lib/api-client";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/runtime-login")({
	validateSearch: (search: Record<string, unknown>) => ({
		callbackUrl:
			typeof search.callbackUrl === "string" ? search.callbackUrl : "",
		clientId: typeof search.clientId === "string" ? search.clientId : "",
		state: typeof search.state === "string" ? search.state : "",
	}),
	component: RuntimeLoginPage,
});

function isLoopbackCallbackUrl(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol !== "http:") {
			return false;
		}
		return (
			url.hostname === "127.0.0.1" ||
			url.hostname === "localhost" ||
			url.hostname === "[::1]" ||
			url.hostname === "::1"
		);
	} catch {
		return false;
	}
}

function getRedirectTarget(): string {
	if (typeof window === "undefined") {
		return "/runtime-login";
	}
	return `${window.location.pathname}${window.location.search}`;
}

function submitRefreshToken(
	callbackUrl: string,
	state: string,
	refreshToken: string
) {
	const form = document.createElement("form");
	form.method = "POST";
	form.action = callbackUrl;

	for (const [name, value] of Object.entries({ refreshToken, state })) {
		const input = document.createElement("input");
		input.type = "hidden";
		input.name = name;
		input.value = value;
		form.appendChild(input);
	}

	document.body.appendChild(form);
	form.submit();
}

function RuntimeLoginPage() {
	const search = Route.useSearch();
	const { data: session, isPending } = authClient.useSession();
	const [error, setError] = useState<string | null>(null);
	const hasStartedRef = useRef(false);
	const isValidRequest =
		Boolean(search.clientId && search.state) &&
		isLoopbackCallbackUrl(search.callbackUrl);

	useEffect(() => {
		if (!(isValidRequest && session?.user) || hasStartedRef.current) {
			return;
		}

		hasStartedRef.current = true;
		let cancelled = false;

		void (async () => {
			try {
				const { refreshToken } = await apiClient.runtimeAuth.createRefreshToken(
					{
						clientId: search.clientId,
					}
				);
				if (cancelled) {
					return;
				}
				submitRefreshToken(search.callbackUrl, search.state, refreshToken);
			} catch (cause) {
				if (cancelled) {
					return;
				}
				hasStartedRef.current = false;
				setError(
					cause instanceof Error
						? cause.message
						: "Failed to create runtime credentials"
				);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [
		isValidRequest,
		search.callbackUrl,
		search.clientId,
		search.state,
		session?.user,
	]);

	if (!isValidRequest) {
		return (
			<div className="flex min-h-screen items-center justify-center p-6">
				<div className="w-full max-w-md rounded-lg border p-6">
					<h1 className="font-semibold text-xl">
						Invalid runtime login request
					</h1>
					<p className="mt-2 text-muted-foreground">
						The CLI callback URL or login state is missing or invalid.
					</p>
				</div>
			</div>
		);
	}

	if (isPending) {
		return <Loader />;
	}

	if (!session?.user) {
		return <SignInForm redirectTo={getRedirectTarget()} />;
	}

	return (
		<div className="flex min-h-screen items-center justify-center p-6">
			<div className="w-full max-w-md rounded-lg border p-6">
				<h1 className="font-semibold text-xl">Connecting runtime CLI</h1>
				<p className="mt-2 text-muted-foreground">
					{error
						? error
						: "Creating runtime credentials and sending them back to your CLI."}
				</p>
			</div>
		</div>
	);
}
