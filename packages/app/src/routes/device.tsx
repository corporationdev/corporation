import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import SignInForm from "@/components/sign-in-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { getAuthErrorMessage } from "@/lib/organization";

export const Route = createFileRoute("/device")({
	validateSearch: (search: Record<string, unknown>) => ({
		user_code: typeof search.user_code === "string" ? search.user_code : "",
	}),
	component: DeviceApprovalPage,
});

function getRedirectTarget(): string {
	if (typeof window === "undefined") {
		return "/device";
	}
	return `${window.location.pathname}${window.location.search}`;
}

function DeviceApprovalPage() {
	const search = Route.useSearch();
	const { data: session, isPending } = authClient.useSession();
	const [userCode, setUserCode] = useState(search.user_code.toUpperCase());
	const [submitting, setSubmitting] = useState(false);
	const [approved, setApproved] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (isPending) {
		return (
			<div className="flex min-h-screen items-center justify-center p-6">
				<div className="w-full max-w-md rounded-lg border p-6">
					<p className="text-muted-foreground">Loading...</p>
				</div>
			</div>
		);
	}

	if (!session?.user) {
		return <SignInForm redirectTo={getRedirectTarget()} />;
	}

	return (
		<div className="flex min-h-screen items-center justify-center p-6">
			<div className="w-full max-w-md rounded-lg border p-6">
				<h1 className="font-semibold text-xl">Approve Tendril CLI</h1>
				<p className="mt-2 text-muted-foreground">
					Enter the code shown in your terminal to authorize this CLI.
				</p>
				<form
					className="mt-6 space-y-4"
					onSubmit={(event) => {
						event.preventDefault();
						if (!(userCode.trim() && !submitting)) {
							return;
						}

						setSubmitting(true);
						setError(null);
						authClient.device
							.approve({
								userCode: userCode.trim().toUpperCase(),
							})
							.then((result) => {
								if (!(result.data?.success && !result.error)) {
									throw new Error(getAuthErrorMessage(result.error));
								}
								setApproved(true);
							})
							.catch((cause) => {
								setError(
									cause instanceof Error
										? cause.message
										: "Failed to approve device login"
								);
							})
							.finally(() => {
								setSubmitting(false);
							});
					}}
				>
					<label className="block space-y-2">
						<span className="font-medium text-sm">Device code</span>
						<Input
							autoCapitalize="characters"
							autoCorrect="off"
							className="font-mono uppercase"
							onChange={(event) => {
								setUserCode(event.target.value.toUpperCase());
							}}
							placeholder="ABCD1234"
							value={userCode}
						/>
					</label>
					<Button
						className="w-full"
						disabled={submitting || !userCode.trim()}
						type="submit"
					>
						{submitting ? "Approving..." : "Approve CLI"}
					</Button>
				</form>
				{approved ? (
					<p className="mt-4 text-emerald-600 text-sm">
						CLI approved. You can return to your terminal.
					</p>
				) : null}
				{error ? (
					<p className="mt-4 text-destructive text-sm">{error}</p>
				) : null}
			</div>
		</div>
	);
}
