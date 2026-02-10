import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/settings/connections")({
	component: ConnectionsPage,
});

function ConnectionsPage() {
	return (
		<div className="p-6">
			<h1 className="font-semibold text-lg">Connections</h1>
			<p className="mt-1 text-muted-foreground text-sm">
				Manage your connected services and integrations.
			</p>
		</div>
	);
}
