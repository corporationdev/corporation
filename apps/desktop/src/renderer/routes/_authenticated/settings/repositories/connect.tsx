import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute(
	"/_authenticated/settings/repositories/connect"
)({
	component: ConnectRepositoryPage,
});

function ConnectRepositoryPage() {
	return (
		<div className="p-6">
			<h1 className="font-semibold text-lg">Connect Repository</h1>
			<p className="mt-1 text-muted-foreground text-sm">
				Select a GitHub repository to connect.
			</p>
		</div>
	);
}
