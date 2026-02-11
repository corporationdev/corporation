import { api } from "@corporation/backend/convex/_generated/api";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useConvex } from "convex/react";
import { Check, Plus, Search, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { apiClient } from "@/lib/api-client";

export const Route = createFileRoute(
	"/_authenticated/settings/repositories/connect"
)({
	component: ConnectRepositoryPage,
});

type GitHubRepo = {
	id: number;
	name: string;
	fullName: string;
	owner: string;
	defaultBranch: string;
	private: boolean;
	url: string;
};

async function fetchGitHubRepos() {
	const res = await apiClient.repositories.github.$get({});
	if (!res.ok) {
		throw new Error("Failed to fetch GitHub repositories");
	}
	const data = await res.json();
	return data.repositories;
}

function ConnectRepositoryPage() {
	const navigate = useNavigate();
	const convex = useConvex();

	const {
		data: repos,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["github-repos"],
		queryFn: fetchGitHubRepos,
	});

	const [search, setSearch] = useState("");
	const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
	const [installCommand, setInstallCommand] = useState("");
	const [devCommand, setDevCommand] = useState("");
	const [envVars, setEnvVars] = useState<{ key: string; value: string }[]>([]);

	const filteredRepos = repos?.filter((repo) => {
		const query = search.toLowerCase();
		return (
			repo.name.toLowerCase().includes(query) ||
			repo.owner.toLowerCase().includes(query)
		);
	});

	const handleAddEnvVar = () => {
		setEnvVars([...envVars, { key: "", value: "" }]);
	};

	const handleRemoveEnvVar = (index: number) => {
		setEnvVars(envVars.filter((_, i) => i !== index));
	};

	const handleEnvVarChange = (
		index: number,
		field: "key" | "value",
		value: string
	) => {
		const updated = [...envVars];
		updated[index] = { ...updated[index], [field]: value };
		setEnvVars(updated);
	};

	const connectMutation = useMutation({
		mutationFn: async () => {
			if (!selectedRepo) {
				throw new Error("No repository selected");
			}

			const validEnvVars = envVars.filter(
				(v) => v.key.trim() !== "" && v.value.trim() !== ""
			);

			await convex.mutation(api.repositories.create, {
				githubRepoId: selectedRepo.id,
				owner: selectedRepo.owner,
				name: selectedRepo.name,
				defaultBranch: selectedRepo.defaultBranch,
				installCommand: installCommand.trim() || undefined,
				devCommand: devCommand.trim() || undefined,
				envVars: validEnvVars.length > 0 ? validEnvVars : undefined,
			});
		},
		onSuccess: () => {
			navigate({ to: "/settings/repositories" });
		},
	});

	return (
		<div className="flex flex-col gap-6 p-6">
			<div>
				<h1 className="font-semibold text-lg">Connect Repository</h1>
				<p className="mt-1 text-muted-foreground text-sm">
					Select a GitHub repository and configure its environment.
				</p>
			</div>

			{error && <p className="text-destructive text-sm">{error.message}</p>}

			<div className="flex flex-col gap-2">
				<Label>Repository</Label>
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
					<div className="flex flex-col gap-2">
						<Label htmlFor="install-command">Install Command</Label>
						<Input
							id="install-command"
							onChange={(e) => setInstallCommand(e.target.value)}
							placeholder="e.g. npm install"
							value={installCommand}
						/>
					</div>

					<div className="flex flex-col gap-2">
						<Label htmlFor="dev-command">Dev Command</Label>
						<Input
							id="dev-command"
							onChange={(e) => setDevCommand(e.target.value)}
							placeholder="e.g. npm run dev"
							value={devCommand}
						/>
					</div>

					<div className="flex flex-col gap-2">
						<div className="flex items-center justify-between">
							<Label>Environment Variables</Label>
							<Button onClick={handleAddEnvVar} size="xs" variant="ghost">
								<Plus className="size-3" />
								Add
							</Button>
						</div>
						{envVars.length > 0 && (
							<div className="flex flex-col gap-2">
								{envVars.map((envVar, index) => (
									<div
										className="flex items-center gap-2"
										key={`env-${index.toString()}`}
									>
										<Input
											onChange={(e) =>
												handleEnvVarChange(index, "key", e.target.value)
											}
											placeholder="KEY"
											value={envVar.key}
										/>
										<Input
											onChange={(e) =>
												handleEnvVarChange(index, "value", e.target.value)
											}
											placeholder="value"
											value={envVar.value}
										/>
										<Button
											onClick={() => handleRemoveEnvVar(index)}
											size="icon-sm"
											variant="ghost"
										>
											<Trash2 className="size-3.5" />
										</Button>
									</div>
								))}
							</div>
						)}
					</div>

					<div className="flex justify-end">
						<Button
							disabled={connectMutation.isPending}
							onClick={() => connectMutation.mutate()}
						>
							{connectMutation.isPending
								? "Connecting..."
								: "Connect Repository"}
						</Button>
					</div>
				</>
			)}
		</div>
	);
}
