import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2, MailPlus, UserMinus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CreateOrganizationDialog } from "@/components/create-organization-dialog";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { authClient } from "@/lib/auth-client";
import { getAuthErrorMessage } from "@/lib/organization";

export const Route = createFileRoute("/_authenticated/settings/organization")({
	component: OrganizationSettingsPage,
});

async function fetchMembers(organizationId: string) {
	const result = await authClient.organization.listMembers({
		query: { organizationId },
	});

	if (!(result.data && !result.error)) {
		throw new Error(getAuthErrorMessage(result.error));
	}

	return result.data.members;
}

async function fetchInvitations(organizationId: string) {
	const result = await authClient.organization.listInvitations({
		query: { organizationId },
	});

	if (!(result.data && !result.error)) {
		throw new Error(getAuthErrorMessage(result.error));
	}

	return result.data;
}

function OrganizationSettingsPage() {
	const queryClient = useQueryClient();
	const [inviteEmail, setInviteEmail] = useState("");
	const [createDialogOpen, setCreateDialogOpen] = useState(false);
	const { data: activeOrganization, isPending: isOrganizationPending } =
		authClient.useActiveOrganization();
	const { data: session } = authClient.useSession();
	const activeOrganizationId = activeOrganization?.id;
	const {
		data: members,
		isPending: isMembersPending,
		error: membersError,
	} = useQuery({
		queryKey: ["organization-members", activeOrganizationId],
		queryFn: async () => {
			if (!activeOrganizationId) {
				throw new Error("No active organization");
			}
			return await fetchMembers(activeOrganizationId);
		},
		enabled: Boolean(activeOrganizationId),
	});
	const {
		data: invitations,
		isPending: isInvitationsPending,
		error: invitationsError,
	} = useQuery({
		queryKey: ["organization-invitations", activeOrganizationId],
		queryFn: async () => {
			if (!activeOrganizationId) {
				throw new Error("No active organization");
			}
			return await fetchInvitations(activeOrganizationId);
		},
		enabled: Boolean(activeOrganizationId),
	});
	const inviteMutation = useMutation({
		mutationFn: async () => {
			if (!activeOrganizationId) {
				throw new Error("No active organization");
			}
			const result = await authClient.organization.inviteMember({
				email: inviteEmail.trim(),
				role: "admin",
				organizationId: activeOrganizationId,
			});

			if (!(result.data && !result.error)) {
				throw new Error(getAuthErrorMessage(result.error));
			}
		},
		onSuccess: async () => {
			setInviteEmail("");
			toast.success("Invitation sent");
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: ["organization-invitations", activeOrganizationId],
				}),
				queryClient.invalidateQueries({
					queryKey: ["organization-members", activeOrganizationId],
				}),
			]);
		},
		onError: (error) => {
			toast.error(error.message);
		},
	});
	const cancelInvitationMutation = useMutation({
		mutationFn: async (invitationId: string) => {
			const result = await authClient.organization.cancelInvitation({
				invitationId,
			});

			if (!(result.data && !result.error)) {
				throw new Error(getAuthErrorMessage(result.error));
			}
		},
		onSuccess: async () => {
			toast.success("Invitation canceled");
			await queryClient.invalidateQueries({
				queryKey: ["organization-invitations", activeOrganizationId],
			});
		},
		onError: (error) => {
			toast.error(error.message);
		},
	});
	const removeMemberMutation = useMutation({
		mutationFn: async (memberId: string) => {
			if (!activeOrganizationId) {
				throw new Error("No active organization");
			}
			const result = await authClient.organization.removeMember({
				memberIdOrEmail: memberId,
				organizationId: activeOrganizationId,
			});

			if (!(result.data && !result.error)) {
				throw new Error(getAuthErrorMessage(result.error));
			}
		},
		onSuccess: async () => {
			toast.success("Member removed");
			await queryClient.invalidateQueries({
				queryKey: ["organization-members", activeOrganizationId],
			});
		},
		onError: (error) => {
			toast.error(error.message);
		},
	});

	if (isOrganizationPending) {
		return (
			<div className="flex flex-col gap-4 p-6">
				<Skeleton className="h-20 w-full" />
				<Skeleton className="h-56 w-full" />
			</div>
		);
	}

	if (!activeOrganization) {
		return (
			<div className="p-6">
				<p className="text-muted-foreground text-sm">
					No active organization found.
				</p>
			</div>
		);
	}

	return (
		<>
			<div className="flex flex-col gap-6 p-6">
				<div>
					<h1 className="font-semibold text-lg">Organization</h1>
					<p className="mt-1 text-muted-foreground text-sm">
						Manage the active organization, members, and invitations.
					</p>
				</div>

				<Card>
					<CardHeader>
						<div>
							<CardTitle>{activeOrganization.name}</CardTitle>
							<CardDescription>{activeOrganization.slug}</CardDescription>
						</div>
						<CardAction>
							<Button
								onClick={() => setCreateDialogOpen(true)}
								size="sm"
								variant="outline"
							>
								Create organization
							</Button>
						</CardAction>
					</CardHeader>
				</Card>

				<Card>
					<CardHeader>
						<div>
							<CardTitle>Invite member</CardTitle>
							<CardDescription>
								New members are invited as admins for now.
							</CardDescription>
						</div>
					</CardHeader>
					<CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center">
						<Input
							onChange={(event) => setInviteEmail(event.target.value)}
							placeholder="teammate@company.com"
							type="email"
							value={inviteEmail}
						/>
						<Button
							disabled={inviteMutation.isPending || !inviteEmail.trim()}
							onClick={() => inviteMutation.mutate()}
						>
							{inviteMutation.isPending ? (
								<Loader2 className="animate-spin" />
							) : (
								<MailPlus />
							)}
							Send invite
						</Button>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<div>
							<CardTitle>Members</CardTitle>
							<CardDescription>
								Everyone in this organization currently has admin access.
							</CardDescription>
						</div>
					</CardHeader>
					<CardContent className="flex flex-col gap-3">
						{membersError && (
							<p className="text-destructive text-sm">{membersError.message}</p>
						)}
						{isMembersPending ? (
							<>
								<Skeleton className="h-12 w-full" />
								<Skeleton className="h-12 w-full" />
							</>
						) : members?.length ? (
							members.map((member) => {
								const isCurrentUser = member.userId === session?.user.id;
								return (
									<div
										className="flex items-center justify-between gap-3 border p-3"
										key={member.id}
									>
										<div className="min-w-0">
											<div className="truncate font-medium text-sm">
												{"user" in member && member.user?.name
													? member.user.name
													: "Member"}
											</div>
											<div className="truncate text-muted-foreground text-xs">
												{"user" in member && member.user?.email
													? member.user.email
													: member.userId}
											</div>
										</div>
										<div className="flex items-center gap-2">
											<span className="text-muted-foreground text-xs uppercase">
												{member.role}
											</span>
											<Button
												disabled={
													isCurrentUser || removeMemberMutation.isPending
												}
												onClick={() => removeMemberMutation.mutate(member.id)}
												size="sm"
												variant="ghost"
											>
												<UserMinus />
												Remove
											</Button>
										</div>
									</div>
								);
							})
						) : (
							<p className="text-muted-foreground text-sm">No members found.</p>
						)}
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<div>
							<CardTitle>Pending invitations</CardTitle>
							<CardDescription>
								Outstanding invites for this organization.
							</CardDescription>
						</div>
					</CardHeader>
					<CardContent className="flex flex-col gap-3">
						{invitationsError && (
							<p className="text-destructive text-sm">
								{invitationsError.message}
							</p>
						)}
						{isInvitationsPending ? (
							<>
								<Skeleton className="h-12 w-full" />
								<Skeleton className="h-12 w-full" />
							</>
						) : invitations?.length ? (
							invitations.map((invitation) => (
								<div
									className="flex items-center justify-between gap-3 border p-3"
									key={invitation.id}
								>
									<div className="min-w-0">
										<div className="truncate font-medium text-sm">
											{invitation.email}
										</div>
										<div className="truncate text-muted-foreground text-xs">
											{invitation.role} · {invitation.status}
										</div>
									</div>
									<Button
										disabled={cancelInvitationMutation.isPending}
										onClick={() =>
											cancelInvitationMutation.mutate(invitation.id)
										}
										size="sm"
										variant="ghost"
									>
										Cancel
									</Button>
								</div>
							))
						) : (
							<p className="text-muted-foreground text-sm">
								No pending invitations.
							</p>
						)}
					</CardContent>
				</Card>
			</div>
			<CreateOrganizationDialog
				onOpenChange={setCreateDialogOpen}
				open={createDialogOpen}
			/>
		</>
	);
}
