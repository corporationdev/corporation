// biome-ignore-all lint/style/useFilenamingConvention: TanStack Router uses `$` for dynamic route params
import { api } from "@corporation/backend/convex/_generated/api";
import { useForm } from "@tanstack/react-form";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useConvex, useQuery } from "convex/react";

import { RepositoryConfigFields } from "@/components/repository-config-fields";
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
	const repositories = useQuery(api.repositories.list);
	const repository = repositories?.find((r) => r._id === repositoryId);
	const environments = useQuery(
		api.environments.listByRepository,
		repository ? { repositoryId: repository._id } : "skip"
	);
	const environment = environments?.[0];

	const form = useForm({
		defaultValues: {
			installCommand: environment?.installCommand ?? "",
			devCommand: environment?.devCommand ?? "",
			envVars: environment?.envVars ?? ([] as { key: string; value: string }[]),
		},
		onSubmit: async ({ value }) => {
			if (!environment) {
				return;
			}

			const validEnvVars = value.envVars.filter(
				(v) => v.key.trim() !== "" && v.value.trim() !== ""
			);

			await convex.mutation(api.environments.update, {
				id: environment._id,
				installCommand: value.installCommand.trim() || undefined,
				devCommand: value.devCommand.trim() || undefined,
				envVars: validEnvVars.length > 0 ? validEnvVars : undefined,
			});

			navigate({ to: "/settings/repositories" });
		},
	});

	if (
		repositories === undefined ||
		(repository && environments === undefined)
	) {
		return (
			<div className="p-6">
				<p className="text-muted-foreground text-sm">Loading...</p>
			</div>
		);
	}

	if (!(repository && environment)) {
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

			<RepositoryConfigFields form={form} />

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
