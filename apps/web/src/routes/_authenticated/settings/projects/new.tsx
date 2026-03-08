import { api } from "@corporation/backend/convex/_generated/api";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation as useConvexMutation } from "convex/react";
import { Check, Github, Search } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	buildSecrets,
	ProjectConfigForm,
	type SecretEntry,
} from "@/components/project-config-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import type { GitHubRepo } from "@/hooks/use-github-repos";
import { useGitHubRepos } from "@/hooks/use-github-repos";
import { apiClient } from "@/lib/api-client";

async function fetchIntegrations() {
	const res = await apiClient.integrations.$get({});
	if (!res.ok) {
		throw new Error("Failed to fetch integrations");
	}
	const data = await res.json();
	return data.integrations;
}

export const Route = createFileRoute("/_authenticated/settings/projects/new")({
	component: NewProjectPage,
});

function NewProjectPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const createProject = useConvexMutation(api.projects.create);

	const [search, setSearch] = useState("");
	const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
	const [noGithub, setNoGithub] = useState(false);

	const { data: integrations, isLoading: isIntegrationsLoading } = useQuery({
		queryKey: ["integrations"],
		queryFn: fetchIntegrations,
	});

	const isGithubConnected = integrations?.some(
		(i) => i.unique_key === "github" && i.connection !== null
	);

	const { data: repos, isLoading: isReposLoading } = useGitHubRepos({
		excludeConnected: true,
	});

	const connectGithubMutation = useMutation({
		mutationFn: async () => {
			const res = await apiClient.integrations.connect.$post({
				json: { allowed_integrations: ["github"] },
			});
			if (!res.ok) {
				throw new Error("Failed to create connect session");
			}
			const { connect_link } = await res.json();
			if (connect_link) {
				window.open(connect_link, "_blank");
			}
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["integrations"] });
		},
		onError: (error) => {
			toast.error(error.message);
		},
	});

	const { mutateAsync: doCreate } = useMutation({
		mutationFn: async (value: { name: string; secrets: SecretEntry[] }) => {
			await createProject({
				name: value.name,
				secrets: buildSecrets(value.secrets),
				...(selectedRepo && !noGithub
					? {
							githubRepoId: selectedRepo.id,
							githubOwner: selectedRepo.owner,
							githubName: selectedRepo.name,
							defaultBranch: selectedRepo.defaultBranch,
						}
					: {}),
			});
		},
		onError: (error) => {
			toast.error(error.message);
		},
		onSuccess: () => {
			navigate({ to: "/settings/projects" });
		},
	});

	const form = useForm({
		defaultValues: {
			name: "",
			secrets: [{ key: "", value: "" }],
		},
		onSubmit: async ({ value }) => {
			const name = noGithub ? value.name : (selectedRepo?.name ?? value.name);
			await doCreate({ ...value, name });
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
				<h1 className="font-semibold text-lg">New Project</h1>
				<p className="mt-1 text-muted-foreground text-sm">
					Create a workspace backed by a GitHub repository.
				</p>
			</div>

			{noGithub ? (
				<div className="flex flex-col gap-2">
					<form.Field name="name">
						{(field) => (
							<>
								<FieldLabel>Name</FieldLabel>
								<Input
									name={field.name}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="My project"
									value={field.state.value}
								/>
							</>
						)}
					</form.Field>
				</div>
			) : (
				<div className="flex flex-col gap-2">
					<FieldLabel>GitHub repository</FieldLabel>
					{isIntegrationsLoading ? (
						<Skeleton className="h-12 w-full" />
					) : isGithubConnected ? (
						<>
							<div className="relative">
								<Search className="absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
								<Input
									className="pl-8"
									onChange={(e) => setSearch(e.target.value)}
									placeholder="Search repositories..."
									value={search}
								/>
							</div>

							{isReposLoading ? (
								<div className="flex flex-col gap-2">
									<Skeleton className="h-12 w-full" />
									<Skeleton className="h-12 w-full" />
									<Skeleton className="h-12 w-full" />
								</div>
							) : filteredRepos?.length ? (
								<div className="flex max-h-56 flex-col gap-2 overflow-y-auto">
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
												onClick={() =>
													setSelectedRepo(isSelected ? null : repo)
												}
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
												{isSelected && (
													<Check className="size-4 text-primary" />
												)}
											</button>
										);
									})}
								</div>
							) : (
								<p className="text-muted-foreground text-sm">
									No repositories found.
								</p>
							)}
						</>
					) : (
						<div className="flex flex-col items-start gap-2 rounded-md border border-border p-4">
							<p className="text-muted-foreground text-sm">
								GitHub not connected.
							</p>
							<Button
								disabled={connectGithubMutation.isPending}
								onClick={() => connectGithubMutation.mutate()}
								size="sm"
								type="button"
								variant="outline"
							>
								<Github className="size-4" />
								{connectGithubMutation.isPending
									? "Connecting..."
									: "Connect GitHub"}
							</Button>
						</div>
					)}
				</div>
			)}

			<div className="flex items-center gap-2">
				<Checkbox
					checked={noGithub}
					id="no-github"
					onCheckedChange={(checked) => {
						setNoGithub(checked === true);
						setSelectedRepo(null);
					}}
				/>
				<Label className="text-sm" htmlFor="no-github">
					No GitHub repo
				</Label>
			</div>

			<ProjectConfigForm form={form} />

			<div className="flex justify-end">
				<form.Subscribe
					selector={(state) => ({
						isSubmitting: state.isSubmitting,
						name: state.values.name,
					})}
				>
					{({ isSubmitting, name }) => {
						const canSubmit = noGithub
							? name.trim().length > 0
							: selectedRepo !== null;

						return (
							<Button disabled={!canSubmit || isSubmitting} type="submit">
								{isSubmitting ? "Creating..." : "Create Project"}
							</Button>
						);
					}}
				</form.Subscribe>
			</div>
		</form>
	);
}
