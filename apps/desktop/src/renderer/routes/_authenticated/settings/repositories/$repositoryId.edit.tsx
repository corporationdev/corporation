// biome-ignore-all lint/style/useFilenamingConvention: TanStack Router uses `$` for dynamic route params
import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useForm } from "@tanstack/react-form";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useConvex, useQuery } from "convex/react";
import { ServiceConfigFields } from "@/components/repository-config-fields";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute(
	"/_authenticated/settings/repositories/$repositoryId/edit"
)({
	component: EditRepositoryPage,
});

function EditRepositoryPage() {
	const { repositoryId } = Route.useParams();
	const navigate = useNavigate();
	const convex = useConvex();
	const repository = useQuery(api.repositories.get, {
		id: repositoryId as Id<"repositories">,
	});
	const service = repository?.services[0];

	const form = useForm({
		defaultValues: {
			installCommand: repository?.installCommand ?? "",
			name: service?.name ?? "Main",
			devCommand: service?.devCommand ?? "",
			cwd: service?.cwd ?? "",
			envVars: service?.envVars ?? ([] as { key: string; value: string }[]),
		},
		onSubmit: async ({ value }) => {
			if (!(repository && service)) {
				return;
			}

			const validEnvVars = value.envVars.filter(
				(v) => v.key.trim() !== "" && v.value.trim() !== ""
			);

			await Promise.all([
				convex.mutation(api.repositories.update, {
					id: repository._id,
					installCommand: value.installCommand.trim(),
				}),
				convex.mutation(api.services.update, {
					id: service._id,
					name: value.name.trim() || "Main",
					devCommand: value.devCommand.trim(),
					cwd: value.cwd.trim() || undefined,
					envVars: validEnvVars.length > 0 ? validEnvVars : undefined,
				}),
			]);

			navigate({ to: "/settings/repositories" });
		},
	});

	if (repository === undefined) {
		return (
			<div className="p-6">
				<p className="text-muted-foreground text-sm">Loading...</p>
			</div>
		);
	}

	if (!service) {
		return (
			<div className="p-6">
				<p className="text-destructive text-sm">Repository not found.</p>
			</div>
		);
	}

	return (
		<form
			className="flex flex-col gap-6 p-6"
			onSubmit={(e) => {
				e.preventDefault();
				form.handleSubmit();
			}}
		>
			<div>
				<h1 className="font-semibold text-lg">Edit Repository</h1>
				<p className="mt-1 text-muted-foreground text-sm">
					{repository.owner}/{repository.name}
				</p>
			</div>

			<ServiceConfigFields form={form} prefix="" showName={false} />

			<div className="flex justify-end">
				<form.Subscribe selector={(state) => state.isSubmitting}>
					{(isSubmitting) => (
						<Button disabled={isSubmitting} type="submit">
							{isSubmitting ? "Saving..." : "Save Changes"}
						</Button>
					)}
				</form.Subscribe>
			</div>
		</form>
	);
}
