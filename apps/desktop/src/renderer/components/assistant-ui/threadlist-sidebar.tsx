import { Building } from "lucide-react";
import type * as React from "react";

import { ThreadList } from "@/components/assistant-ui/thread-list";
import { NavUser } from "@/components/nav-user";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarHeader,
	SidebarRail,
} from "@/components/ui/sidebar";
import { useAuthedSession } from "@/hooks/use-authed-session";

export function ThreadListSidebar({
	...props
}: React.ComponentProps<typeof Sidebar>) {
	const { user } = useAuthedSession();

	return (
		<Sidebar {...props}>
			<SidebarHeader className="aui-sidebar-header mb-2">
				<div className="aui-sidebar-header-content flex items-center gap-2 p-2">
					<Building />
					The Corporation
				</div>
			</SidebarHeader>
			<SidebarContent className="aui-sidebar-content px-2">
				<ThreadList />
			</SidebarContent>
			<SidebarRail />
			<SidebarFooter className="aui-sidebar-footer border-t">
				<NavUser user={user} />
			</SidebarFooter>
		</Sidebar>
	);
}
