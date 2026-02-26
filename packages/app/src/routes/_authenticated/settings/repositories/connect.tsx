import { api } from "@corporation/backend/convex/_generated/api";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation as useConvexMutation } from "convex/react";
import { Check, Search } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
	buildEnvByPath,
	type EnvFileValues,
	RepositoryConfigForm,
	repositoryConfigSchema,
} from "@/components/repository-config-form";
import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { GitHubRepo } from "@/hooks/use-github-repos";
import { useGitHubRepos } from "@/hooks/use-github-repos";

export const Route = createFileRoute(
	"/_authenticated/settings/repositories/connect"
)({
	component: ConnectRepositoryPage,
});

function ConnectRepositoryPage() {
	const navigate = useNavigate();
	const createRepo = useConvexMutation(api.repositories.create);
	const {
		data: repos,
		isLoading,
		error,
	} = useGitHubRepos({
		excludeConnected: true,
	});

	const [search, setSearch] = useState("");
	const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);

	const { mutateAsync: connectRepo } = useMutation({
		mutationFn: async (value: {
			setupCommand: string;
			devCommand: string;
			envFiles: EnvFileValues[];
		}) => {
			if (!selectedRepo) {
				throw new Error("No repository selected");
			}

			const envByPath = buildEnvByPath(value.envFiles);

			await createRepo({
				githubRepoId: selectedRepo.id,
				owner: selectedRepo.owner,
				name: selectedRepo.name,
				defaultBranch: selectedRepo.defaultBranch,
				environmentConfig: {
					setupCommand: value.setupCommand,
					devCommand: value.devCommand,
					envByPath,
				},
			});
		},
		onError: (error) => {
			toast.error(error.message);
		},
		onSuccess: () => {
			navigate({ to: "/settings/repositories" });
		},
	});

	const form = useForm({
		defaultValues: {
			setupCommand: "",
			devCommand: "",
			envFiles: [{ path: "", envVars: [{ key: "", value: "" }] }],
		},
		validators: {
			onSubmit: repositoryConfigSchema,
		},
		onSubmit: async ({ value }) => {
			await connectRepo(value);
		},
	});

	const filteredRepos = repos?.filter((repo) => {
		const query = search.toLowerCase();
		return (
			repo.name.toLowerCase().includes(query) ||
			repo.owner.toLowerCase().includes(query)
		);
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
				<h1 className="font-semibold text-lg">Connect Repository</h1>
				<p className="mt-1 text-muted-foreground text-sm">
					Select a GitHub repository and configure its environment.
				</p>
			</div>

			{error && <p className="text-destructive text-sm">{error.message}</p>}

			<div className="flex flex-col gap-2">
				<FieldLabel>Repository</FieldLabel>
				<div className="relative">
					<Search className="absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
					<Input
						className="pl-8"
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search repositories..."
						value={search}
					/>
				</div>

				{isLoading ? (
					<div className="flex flex-col gap-2">
						<Skeleton className="h-12 w-full" />
						<Skeleton className="h-12 w-full" />
						<Skeleton className="h-12 w-full" />
					</div>
				) : filteredRepos?.length ? (
					<div className="flex max-h-64 flex-col gap-2 overflow-y-auto">
						{filteredRepos.map((repo) => {
							const isSelected = selectedRepo?.id === repo.id;
							return (
								<button
									className={`flex w-full cursor-pointer items-center justify-between rounded-none border px-3 py-2 text-left text-sm transition-colors ${
										isSelected
											? "border-primary bg-primary/5"
											: "border-border hover:bg-muted"
									}`}
									key={repo.id}
									onClick={() => setSelectedRepo(repo)}
									type="button"
								>
									<div>
										<div className="font-medium">
											{repo.owner}/{repo.name}
										</div>
										<div className="text-muted-foreground text-xs">
											{repo.private ? "Private" : "Public"} ·{" "}
											{repo.defaultBranch}
										</div>
									</div>
									{isSelected && <Check className="size-4 text-primary" />}
								</button>
							);
						})}
					</div>
				) : (
					<p className="text-muted-foreground text-sm">
						No repositories found.
					</p>
				)}
			</div>

			{selectedRepo && (
				<>
					<RepositoryConfigForm form={form} />

					<div className="flex justify-end">
						<form.Subscribe selector={(state) => state.isSubmitting}>
							{(isSubmitting) => (
								<Button disabled={!selectedRepo || isSubmitting} type="submit">
									{isSubmitting ? "Connecting..." : "Connect Repository"}
								</Button>
							)}
						</form.Subscribe>
					</div>
				</>
			)}
		</form>
	);
}
