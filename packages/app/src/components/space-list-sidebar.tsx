import { Link } from "@tanstack/react-router";
import { Sprout } from "lucide-react";
import type * as React from "react";
import { NavUser } from "@/components/nav-user";
import { OrganizationSwitcher } from "@/components/organization-switcher";
import { SpaceList } from "@/components/space-list";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarHeader,
	SidebarRail,
} from "@/components/ui/sidebar";
import { useAuthedSession } from "@/hooks/use-authed-session";

export function SpaceListSidebar({
	...props
}: React.ComponentProps<typeof Sidebar>) {
	const { user } = useAuthedSession();

	return (
		<Sidebar {...props}>
			<SidebarHeader className="aui-sidebar-header mb-2 gap-2">
				<Link
					className="aui-sidebar-header-content flex items-center gap-1 p-2"
					to="/"
				>
					<Sprout className="size-4" />
					Tendril
				</Link>
				<OrganizationSwitcher />
			</SidebarHeader>
			<SidebarContent className="aui-sidebar-content px-2">
				<SpaceList />
			</SidebarContent>
			<SidebarRail />
			<SidebarFooter className="aui-sidebar-footer border-t">
				<NavUser user={user} />
			</SidebarFooter>
		</Sidebar>
	);
}
