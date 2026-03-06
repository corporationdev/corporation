import { api } from "@corporation/backend/convex/_generated/api";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { useEffect } from "react";
import Loader from "@/components/loader";
import { SpaceListSidebar } from "@/components/space-list-sidebar";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";

export const Route = createFileRoute("/_authenticated/")({
	component: AuthenticatedIndex,
});

function AuthenticatedIndex() {
	const navigate = useNavigate();
	const repositories = useQuery(api.repositories.list);

	useEffect(() => {
		if (!repositories) {
			return;
		}
		const firstRepo = repositories[0];
		if (firstRepo) {
			navigate({
				to: "/repository/$repositoryId",
				params: { repositoryId: firstRepo._id },
				replace: true,
			});
		}
	}, [repositories, navigate]);

	return (
		<div className="flex h-full w-full overflow-hidden">
			<SpaceListSidebar />
			<SidebarInset className="min-h-0 overflow-hidden">
				<header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
					<SidebarTrigger />
				</header>
				<div className="flex min-h-0 flex-1 items-center justify-center">
					{repositories === undefined ? (
						<Loader />
					) : repositories.length === 0 ? (
						<p className="text-muted-foreground">
							Connect a repository to get started.
						</p>
					) : null}
				</div>
			</SidebarInset>
		</div>
	);
}
