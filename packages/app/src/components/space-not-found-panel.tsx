import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export function SpaceNotFoundPanel() {
	const navigate = useNavigate();

	return (
		<div className="flex min-h-0 flex-1 items-center justify-center p-6">
			<div className="w-full max-w-md rounded-lg border bg-card p-6 text-center">
				<p className="font-semibold text-2xl">404</p>
				<h2 className="mt-2 font-semibold text-xl">Space not found</h2>
				<p className="mt-2 text-muted-foreground text-sm">
					The requested space does not exist or you do not have access to it.
				</p>
				<Button
					className="mt-4 w-full"
					onClick={() => navigate({ to: "/space" })}
					type="button"
					variant="outline"
				>
					Back to spaces
				</Button>
			</div>
		</div>
	);
}
