// biome-ignore-all lint/style/useFilenamingConvention: TanStack Router uses `$` for dynamic route params
import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useForm } from "@tanstack/react-form";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";

import {
	RepositoryConfigForm,
	repositoryConfigSchema,
} from "@/components/repository-config-form";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute(
	"/_authenticated/settings/repositories/$repositoryId/edit"
)({
	component: EditRepositoryPage,
});

function EditRepositoryPage() {
	const { repositoryId } = Route.useParams();
	const repository = useQuery(api.repositories.get, {
		id: repositoryId as Id<"repositories">,
	});

	if (repository === undefined) {
		return (
			<div className="p-6">
				<p className="text-muted-foreground text-sm">Loading...</p>
			</div>
		);
	}

	return <EditRepositoryForm repository={repository} />;
}

function EditRepositoryForm({
	repository,
}: {
	repository: NonNullable<
		ReturnType<typeof useQuery<typeof api.repositories.get>>
	>;
}) {
	const navigate = useNavigate();
	const updateRepository = useMutation(api.repositories.update);

	const form = useForm({
		defaultValues: {
			setupCommand: repository.setupCommand ?? "",
			devCommand: repository.devCommand ?? "",
			envVars: repository.envVars?.length
				? repository.envVars
				: [{ key: "", value: "" }],
			services: repository.services.map((s) => ({
				path: s.path,
				envVars: s.envVars?.length ? s.envVars : [{ key: "", value: "" }],
			})),
		},
		validators: {
			onSubmit: repositoryConfigSchema,
		},
		onSubmit: async ({ value }) => {
			const envVars = value.envVars.filter((v) => v.key.trim() !== "");
			const services = value.services.map((s) => ({
				...s,
				envVars: s.envVars.filter((v) => v.key.trim() !== ""),
			}));

			await updateRepository({
				id: repository._id,
				setupCommand: value.setupCommand,
				devCommand: value.devCommand,
				envVars: envVars.length > 0 ? envVars : undefined,
				services,
			});

			navigate({ to: "/settings/repositories" });
		},
	});

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

			<RepositoryConfigForm form={form} />

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
