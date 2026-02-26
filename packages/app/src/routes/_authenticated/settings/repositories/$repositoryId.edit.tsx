// biome-ignore-all lint/style/useFilenamingConvention: TanStack Router uses `$` for dynamic route params
import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useForm } from "@tanstack/react-form";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";

import {
	buildEnvByPath,
	envFilesFromEnvByPath,
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

	if (!repository.defaultEnvironment) {
		return (
			<div className="p-6">
				<p className="text-muted-foreground text-sm">
					Repository configuration is unavailable.
				</p>
			</div>
		);
	}

	return (
		<EditRepositoryForm
			defaultEnvironment={repository.defaultEnvironment}
			repository={repository}
		/>
	);
}

function EditRepositoryForm({
	defaultEnvironment,
	repository,
}: {
	defaultEnvironment: NonNullable<
		NonNullable<
			ReturnType<typeof useQuery<typeof api.repositories.get>>
		>["defaultEnvironment"]
	>;
	repository: NonNullable<
		ReturnType<typeof useQuery<typeof api.repositories.get>>
	>;
}) {
	const navigate = useNavigate();
	const updateEnvironment = useMutation(api.environments.update);

	const form = useForm({
		defaultValues: {
			setupCommand: defaultEnvironment.setupCommand,
			devCommand: defaultEnvironment.devCommand,
			envFiles: envFilesFromEnvByPath(defaultEnvironment.envByPath),
		},
		validators: {
			onSubmit: repositoryConfigSchema,
		},
		onSubmit: async ({ value }) => {
			await updateEnvironment({
				id: defaultEnvironment._id,
				setupCommand: value.setupCommand,
				devCommand: value.devCommand,
				envByPath: buildEnvByPath(value.envFiles),
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
