import { useForm } from "@tanstack/react-form";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Check, Plus, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
	ServiceConfigFields,
	type ServiceValues,
} from "@/components/repository-config-fields";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import type { GitHubRepo } from "@/hooks/use-github-repos";
import { useGitHubRepos } from "@/hooks/use-github-repos";
import { apiClient } from "@/lib/api-client";

export const Route = createFileRoute(
	"/_authenticated/settings/repositories/connect"
)({
	component: ConnectRepositoryPage,
});

const emptyService: ServiceValues = {
	name: "",
	devCommand: "",
	cwd: "",
	envVars: [],
};

function ConnectRepositoryPage() {
	const navigate = useNavigate();
	const {
		data: repos,
		isLoading,
		error,
	} = useGitHubRepos({
		excludeConnected: true,
	});

	const [search, setSearch] = useState("");
	const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
	const [isMonorepo, setIsMonorepo] = useState(false);

	const form = useForm({
		defaultValues: {
			installCommand: "",
			services: [
				{ name: "Main", devCommand: "", cwd: "", envVars: [] },
			] as ServiceValues[],
		},
		onSubmit: async ({ value }) => {
			if (!selectedRepo) {
				return;
			}

			const services = value.services
				.filter((s) => s.devCommand.trim() !== "")
				.map((s) => {
					const validEnvVars = s.envVars.filter(
						(v) => v.key.trim() !== "" && v.value.trim() !== ""
					);
					return {
						name: s.name.trim() || "Main",
						devCommand: s.devCommand.trim(),
						cwd: s.cwd.trim() || undefined,
						envVars: validEnvVars.length > 0 ? validEnvVars : undefined,
					};
				});

			if (services.length === 0) {
				toast.error("At least one service with a dev command is required");
				return;
			}

			const res = await apiClient.repositories.connect.$post({
				json: {
					githubRepoId: selectedRepo.id,
					owner: selectedRepo.owner,
					name: selectedRepo.name,
					defaultBranch: selectedRepo.defaultBranch,
					installCommand: value.installCommand.trim(),
					services,
				},
			});

			if (!res.ok) {
				const data = await res.json();
				toast.error(data.error);
				return;
			}

			navigate({ to: "/settings/repositories" });
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
					<Field>
						<FieldLabel htmlFor="installCommand">Install Command</FieldLabel>
						<form.Field name="installCommand">
							{(field) => (
								<Input
									id={field.name}
									name={field.name}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="e.g. npm install"
									value={field.state.value}
								/>
							)}
						</form.Field>
					</Field>

					<Label>
						<Checkbox
							checked={isMonorepo}
							onCheckedChange={(checked) => setIsMonorepo(checked === true)}
						/>
						This is a monorepo
					</Label>

					{isMonorepo ? (
						<form.Field mode="array" name="services">
							{(servicesField) => (
								<div className="flex flex-col gap-4">
									<div className="flex items-center justify-between">
										<FieldLabel>Services</FieldLabel>
										<Button
											onClick={() =>
												servicesField.pushValue({ ...emptyService })
											}
											size="xs"
											type="button"
											variant="ghost"
										>
											<Plus className="size-3" />
											Add Service
										</Button>
									</div>
									{servicesField.state.value.map(
										(_: ServiceValues, index: number) => (
											<div
												className="relative flex flex-col gap-3 border p-4"
												key={`service-${index.toString()}`}
											>
												{servicesField.state.value.length > 1 && (
													<Button
														className="absolute top-2 right-2"
														onClick={() => servicesField.removeValue(index)}
														size="icon-sm"
														type="button"
														variant="ghost"
													>
														<Trash2 className="size-3.5" />
													</Button>
												)}
												<ServiceConfigFields
													form={form}
													prefix={`services[${index}]`}
													showName
												/>
											</div>
										)
									)}
								</div>
							)}
						</form.Field>
					) : (
						<ServiceConfigFields
							form={form}
							prefix="services[0]"
							showName={false}
						/>
					)}

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
