import { useMutation } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { CreateOrganizationDialog } from "@/components/create-organization-dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "@/components/ui/sidebar";
import { clearTokenCache } from "@/lib/api-client";
import { authClient } from "@/lib/auth-client";
import {
	getAuthErrorMessage,
	getOrganizationInitials,
} from "@/lib/organization";

function OrganizationAvatar({ name }: { name: string }) {
	return (
		<div className="flex size-8 items-center justify-center border border-sidebar-border bg-sidebar-primary font-medium text-sidebar-primary-foreground text-xs">
			{getOrganizationInitials(name) || "OR"}
		</div>
	);
}

export function OrganizationSwitcher() {
	const { isMobile } = useSidebar();
	const [createDialogOpen, setCreateDialogOpen] = useState(false);
	const { data: activeOrganization, isPending: isActiveOrganizationPending } =
		authClient.useActiveOrganization();
	const { data: organizations, isPending: isOrganizationsPending } =
		authClient.useListOrganizations();
	const switchOrganizationMutation = useMutation({
		mutationFn: async (organizationId: string) => {
			const result = await authClient.organization.setActive({
				organizationId,
			});
			if (!(result.data && !result.error)) {
				throw new Error(getAuthErrorMessage(result.error));
			}
		},
		onSuccess: () => {
			clearTokenCache();
			window.location.assign("/");
		},
		onError: (error) => {
			toast.error(error.message);
		},
	});
	const organizationItems = useMemo(() => organizations ?? [], [organizations]);

	if (
		isActiveOrganizationPending ||
		isOrganizationsPending ||
		!(activeOrganization && organizationItems.length > 0)
	) {
		return (
			<div className="px-2">
				<div className="flex h-12 items-center border border-sidebar-border px-2 text-sidebar-foreground text-xs">
					Loading organization...
				</div>
			</div>
		);
	}

	return (
		<>
			<SidebarMenu>
				<SidebarMenuItem>
					<DropdownMenu>
						<SidebarMenuButton
							className="border border-sidebar-border data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground"
							render={<DropdownMenuTrigger />}
							size="lg"
						>
							<OrganizationAvatar name={activeOrganization.name} />
							<div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
								<span className="truncate font-medium">
									{activeOrganization.name}
								</span>
								<span className="truncate text-muted-foreground text-xs">
									{activeOrganization.slug}
								</span>
							</div>
							<ChevronsUpDown className="ml-auto size-4" />
						</SidebarMenuButton>
						<DropdownMenuContent
							align="start"
							className="w-(--anchor-width) min-w-64 rounded-lg"
							side={isMobile ? "bottom" : "right"}
							sideOffset={4}
						>
							<DropdownMenuLabel className="text-muted-foreground text-xs">
								Organizations
							</DropdownMenuLabel>
							{organizationItems.map((organization, index) => (
								<DropdownMenuItem
									className="gap-2 p-2"
									disabled={switchOrganizationMutation.isPending}
									key={organization.id}
									onClick={() =>
										switchOrganizationMutation.mutate(organization.id)
									}
								>
									<OrganizationAvatar name={organization.name} />
									<div className="grid flex-1 text-left text-sm leading-tight">
										<span className="truncate font-medium">
											{organization.name}
										</span>
										<span className="truncate text-muted-foreground text-xs">
											{organization.slug}
										</span>
									</div>
									{activeOrganization.id === organization.id ? (
										<Check className="size-4" />
									) : (
										<span className="text-muted-foreground text-xs">
											⌘{index + 1}
										</span>
									)}
								</DropdownMenuItem>
							))}
							<DropdownMenuSeparator />
							<DropdownMenuItem
								className="gap-2 p-2"
								onClick={() => setCreateDialogOpen(true)}
							>
								<div className="flex size-8 items-center justify-center border border-sidebar-border border-dashed">
									<Plus className="size-4" />
								</div>
								<div className="font-medium text-sm">Create organization</div>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</SidebarMenuItem>
			</SidebarMenu>
			<CreateOrganizationDialog
				onOpenChange={setCreateDialogOpen}
				open={createDialogOpen}
			/>
		</>
	);
}
