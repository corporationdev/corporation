import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { clearTokenCache } from "@/lib/api-client";
import { authClient } from "@/lib/auth-client";
import { getAuthErrorMessage } from "@/lib/organization";

export const Route = createFileRoute("/accept-invitation")({
	validateSearch: (search: Record<string, unknown>) => ({
		id: typeof search.id === "string" ? search.id : "",
	}),
	component: AcceptInvitationPage,
});

function MissingInvitationState() {
	return (
		<p className="text-muted-foreground text-sm">
			This invitation link is missing an invitation id.
		</p>
	);
}

function UnauthenticatedInvitationState({
	onSignIn,
	onSignUp,
}: {
	onSignIn: () => void;
	onSignUp: () => void;
}) {
	return (
		<>
			<p className="text-muted-foreground text-sm">
				Sign in or create an account with the invited email address to accept
				this invitation.
			</p>
			<div className="flex gap-2">
				<Button onClick={onSignIn} variant="outline">
					Sign in
				</Button>
				<Button onClick={onSignUp}>Create account</Button>
			</div>
		</>
	);
}

function InvitationContent({
	acceptInvitationMutation,
	invitation,
	invitationError,
	invitationId,
	isInvitationPending,
	isSessionPending,
	onAccept,
	onDecline,
	onSignIn,
	onSignUp,
	sessionEmail,
}: {
	acceptInvitationMutation: { isPending: boolean };
	invitation:
		| {
				organizationName: string;
				role: string;
				inviterEmail: string;
		  }
		| null
		| undefined;
	invitationError: Error | null;
	invitationId: string;
	isInvitationPending: boolean;
	isSessionPending: boolean;
	onAccept: () => void;
	onDecline: () => void;
	onSignIn: () => void;
	onSignUp: () => void;
	sessionEmail?: string;
}) {
	if (!invitationId) {
		return <MissingInvitationState />;
	}

	if (isSessionPending) {
		return (
			<div className="flex items-center gap-2 text-muted-foreground text-sm">
				<Loader2 className="animate-spin" />
				Checking session...
			</div>
		);
	}

	if (!sessionEmail) {
		return (
			<UnauthenticatedInvitationState onSignIn={onSignIn} onSignUp={onSignUp} />
		);
	}

	if (isInvitationPending) {
		return (
			<div className="flex items-center gap-2 text-muted-foreground text-sm">
				<Loader2 className="animate-spin" />
				Loading invitation...
			</div>
		);
	}

	if (invitationError) {
		return (
			<p className="text-destructive text-sm">{invitationError.message}</p>
		);
	}

	if (!invitation) {
		return null;
	}

	return (
		<>
			<div className="space-y-1 text-sm">
				<p>
					You were invited to join{" "}
					<strong>{invitation.organizationName}</strong>.
				</p>
				<p className="text-muted-foreground">
					Invited as <strong>{invitation.role}</strong> by{" "}
					{invitation.inviterEmail}.
				</p>
				<p className="text-muted-foreground">
					Signed in as <strong>{sessionEmail}</strong>.
				</p>
			</div>
			<div className="flex gap-2">
				<Button
					disabled={acceptInvitationMutation.isPending}
					onClick={onAccept}
				>
					{acceptInvitationMutation.isPending ? (
						<Loader2 className="animate-spin" />
					) : null}
					Accept invitation
				</Button>
				<Button
					disabled={acceptInvitationMutation.isPending}
					onClick={onDecline}
					variant="outline"
				>
					Decline
				</Button>
			</div>
		</>
	);
}

function AcceptInvitationPage() {
	const navigate = useNavigate({ from: "/" });
	const search = Route.useSearch();
	const invitationId = "id" in search ? search.id : "";
	const { data: session, isPending: isSessionPending } =
		authClient.useSession();
	const redirectTo = `/accept-invitation?id=${encodeURIComponent(invitationId)}`;
	const invitationQuery = useQuery({
		queryKey: ["organization-invitation", invitationId],
		queryFn: async () => {
			const result = await authClient.organization.getInvitation({
				query: { id: invitationId },
			});

			if (!(result.data && !result.error)) {
				throw new Error(getAuthErrorMessage(result.error));
			}

			return result.data;
		},
		enabled: Boolean(invitationId && session?.user),
	});
	const acceptInvitationMutation = useMutation({
		mutationFn: async () => {
			const result = await authClient.organization.acceptInvitation({
				invitationId,
			});

			if (!(result.data && !result.error)) {
				throw new Error(getAuthErrorMessage(result.error));
			}

			if (invitationQuery.data?.organizationId) {
				await authClient.organization.setActive({
					organizationId: invitationQuery.data.organizationId,
				});
			}
		},
		onSuccess: () => {
			toast.success("Invitation accepted");
			clearTokenCache();
			window.location.assign("/");
		},
		onError: (error) => {
			toast.error(error.message);
		},
	});
	const rejectInvitationMutation = useMutation({
		mutationFn: async () => {
			const result = await authClient.organization.rejectInvitation({
				invitationId,
			});

			if (!(result.data && !result.error)) {
				throw new Error(getAuthErrorMessage(result.error));
			}
		},
		onSuccess: () => {
			toast.success("Invitation declined");
			navigate({ to: "/" });
		},
		onError: (error) => {
			toast.error(error.message);
		},
	});

	return (
		<div className="flex min-h-screen items-center justify-center p-6">
			<Card className="w-full max-w-lg">
				<CardHeader>
					<CardTitle>Organization invitation</CardTitle>
					<CardDescription>
						Join an organization from an email invitation.
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<InvitationContent
						acceptInvitationMutation={acceptInvitationMutation}
						invitation={invitationQuery.data}
						invitationError={invitationQuery.error}
						invitationId={invitationId}
						isInvitationPending={invitationQuery.isPending}
						isSessionPending={isSessionPending}
						onAccept={() => acceptInvitationMutation.mutate()}
						onDecline={() => rejectInvitationMutation.mutate()}
						onSignIn={() =>
							navigate({
								to: "/login",
								search: { redirect: redirectTo },
							})
						}
						onSignUp={() =>
							navigate({
								to: "/signup",
								search: { redirect: redirectTo },
							})
						}
						sessionEmail={session?.user.email}
					/>
				</CardContent>
			</Card>
		</div>
	);
}
