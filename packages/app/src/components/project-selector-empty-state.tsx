import { Link } from "@tanstack/react-router";
import {
	CheckIcon,
	ChevronUpIcon,
	FolderIcon,
	FolderPlusIcon,
} from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Project } from "@/hooks/use-projects";
import { useProjects } from "@/hooks/use-projects";
import { cn } from "@/lib/utils";

function getProjectLabel(project: Project) {
	return project.githubOwner && project.githubName
		? `${project.githubOwner}/${project.githubName}`
		: project.name;
}

export function ProjectSelectorEmptyState() {
	const { projects, selectedProjectId, setSelectedProjectId, isLoading } =
		useProjects();

	if (isLoading) {
		return (
			<div className="flex size-full flex-col items-center justify-center gap-3 p-8 text-center">
				<div className="text-muted-foreground text-sm">Loading projects…</div>
			</div>
		);
	}

	const selectedProject = selectedProjectId
		? projects.find((p) => p._id === selectedProjectId)
		: projects[0];
	const displayLabel = selectedProject
		? getProjectLabel(selectedProject)
		: "Select project";

	return (
		<div className="flex size-full flex-col items-center justify-center gap-3 p-8 text-center">
			<div aria-hidden className="text-muted-foreground">
				<svg
					aria-hidden
					className="mx-auto size-12"
					fill="none"
					stroke="currentColor"
					strokeWidth={1.5}
					viewBox="0 0 24 24"
				>
					<title>Cloud</title>
					<path
						d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</div>
			<div className="flex flex-col items-center gap-1">
				<p className="text-muted-foreground text-sm">
					Let's build{" "}
					<DropdownMenu>
						<DropdownMenuTrigger
							className={cn(
								"inline-flex cursor-pointer items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
							)}
						>
							{displayLabel}
							<ChevronUpIcon className="size-3.5" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="center" className="min-w-56">
							<DropdownMenuGroup>
								<DropdownMenuLabel className="text-muted-foreground text-xs">
									Select your project
								</DropdownMenuLabel>
								{projects.map((project) => (
									<DropdownMenuItem
										key={project._id}
										onClick={() => setSelectedProjectId(project._id)}
									>
										<FolderIcon className="mr-2 size-4 shrink-0" />
										<span className="min-w-0 flex-1 truncate">
											{getProjectLabel(project)}
										</span>
										{selectedProjectId === project._id && (
											<CheckIcon className="ml-2 size-4 shrink-0" />
										)}
									</DropdownMenuItem>
								))}
								<DropdownMenuItem asChild>
									<Link
										className="flex cursor-pointer items-center"
										to="/settings/projects/new"
									>
										<FolderPlusIcon className="mr-2 size-4 shrink-0" />
										Add new project
									</Link>
								</DropdownMenuItem>
							</DropdownMenuGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				</p>
				<p className="text-muted-foreground text-xs">
					Type a message below to begin chatting
				</p>
			</div>
		</div>
	);
}
