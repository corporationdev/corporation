import { Link } from "@tanstack/react-router";
import { Building, PlusIcon } from "lucide-react";
import type * as React from "react";
import { NavUser } from "@/components/nav-user";
import { SpaceList } from "@/components/space-list";
import { buttonVariants } from "@/components/ui/button";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarHeader,
	SidebarRail,
} from "@/components/ui/sidebar";
import { useAuthedSession } from "@/hooks/use-authed-session";
import { cn } from "@/lib/utils";

export function SpaceListSidebar({
	...props
}: React.ComponentProps<typeof Sidebar>) {
	const { user } = useAuthedSession();

	return (
		<Sidebar {...props}>
			<SidebarHeader className="aui-sidebar-header mb-2">
				<Link
					className="aui-sidebar-header-content flex items-center gap-2 p-2"
					to="/"
				>
					<Building />
					The Corporation
				</Link>
			</SidebarHeader>
			<SidebarContent className="aui-sidebar-content px-2">
				<Link
					className={cn(
						buttonVariants({ variant: "outline" }),
						"mb-2 h-8 w-full justify-start px-2 text-xs"
					)}
					to="/"
				>
					<PlusIcon className="size-3.5" />
					New space
				</Link>
				<SpaceList />
			</SidebarContent>
			<SidebarRail />
			<SidebarFooter className="aui-sidebar-footer border-t">
				<NavUser user={user} />
			</SidebarFooter>
		</Sidebar>
	);
}
