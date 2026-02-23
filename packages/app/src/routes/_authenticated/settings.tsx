import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { ArrowLeft, Cable, GitFork } from "lucide-react";

export const Route = createFileRoute("/_authenticated/settings")({
	component: SettingsLayout,
});

const navItems = [
	{ label: "Repositories", href: "/settings/repositories", icon: GitFork },
	{ label: "Connections", href: "/settings/connections", icon: Cable },
];

function SettingsLayout() {
	return (
		<div className="flex h-full w-full">
			<nav className="flex w-56 shrink-0 flex-col border-r">
				<div className="flex h-12 items-center border-b px-4">
					<Link
						className="flex items-center gap-2 text-muted-foreground text-sm hover:text-foreground"
						to="/space"
					>
						<ArrowLeft className="size-4" />
						Settings
					</Link>
				</div>
				<div className="flex flex-col gap-1 p-2">
					{navItems.map((item) => (
						<Link
							activeProps={{
								className: "bg-accent text-accent-foreground",
							}}
							className="flex items-center gap-2 rounded-md px-3 py-2 text-muted-foreground text-sm hover:bg-accent hover:text-accent-foreground"
							key={item.href}
							to={item.href}
						>
							<item.icon className="size-4" />
							{item.label}
						</Link>
					))}
				</div>
			</nav>
			<main className="flex-1 overflow-y-auto">
				<Outlet />
			</main>
		</div>
	);
}
