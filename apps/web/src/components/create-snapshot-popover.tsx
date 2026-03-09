import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import {
	BoxIcon,
	CameraIcon,
	ChevronDownIcon,
	CopyIcon,
	LoaderCircleIcon,
	PauseIcon,
	PlayIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";

type CreateSnapshotPopoverProps = {
	spaceId: Id<"spaces"> | undefined;
	status: "creating" | "running" | "paused" | "killed" | "error" | undefined;
	sandboxId: string | undefined;
};

export function CreateSnapshotPopover({
	spaceId,
	status,
	sandboxId,
}: CreateSnapshotPopoverProps) {
	const [open, setOpen] = useState(false);
	const [isSnapshotFormOpen, setIsSnapshotFormOpen] = useState(false);
	const [label, setLabel] = useState("");
	const [makeDefault, setMakeDefault] = useState(false);
	const [pendingSandboxAction, setPendingSandboxAction] = useState<
		"start" | "pause" | null
	>(null);
	const labelId = useId();
	const defaultId = useId();
	const createSnapshot = useMutation(api.snapshot.createFromSpace);
	const pauseSandbox = useMutation(api.spaces.pauseSandbox);
	const startSandbox = useMutation(api.spaces.startSandbox);

	const sandboxStatus = status ?? "paused";
	const isRunning = sandboxStatus === "running";
	const isStarting = sandboxStatus === "creating";
	const canCreateSnapshot = !!(spaceId && sandboxId);
	const showStartButton =
		sandboxStatus === "paused" ||
		sandboxStatus === "killed" ||
		sandboxStatus === "error";
	const canToggleSandbox = !!spaceId && !isStarting;
	const isUpdatingSandbox = pendingSandboxAction !== null;

	const statusCopy = getSandboxStatusCopy(sandboxStatus);

	const handleOpenChange = (nextOpen: boolean) => {
		setOpen(nextOpen);
		if (!nextOpen) {
			setIsSnapshotFormOpen(false);
		}
	};

	const handleCreate = async () => {
		if (!(canCreateSnapshot && spaceId)) {
			toast.error("Sandbox is not running");
			return;
		}

		try {
			await createSnapshot({
				spaceId,
				label: label.trim() || undefined,
				setAsDefault: makeDefault,
			});
			toast.success("Snapshot started");
			setOpen(false);
			setIsSnapshotFormOpen(false);
			setLabel("");
			setMakeDefault(false);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to create snapshot"
			);
		}
	};

	const handleToggleSandbox = async () => {
		if (!(spaceId && canToggleSandbox)) {
			return;
		}

		setPendingSandboxAction(isRunning ? "pause" : "start");
		try {
			if (isRunning) {
				await pauseSandbox({ id: spaceId });
				toast.success("Sandbox pause started");
			} else {
				await startSandbox({ id: spaceId });
				toast.success("Sandbox start queued");
			}
			setOpen(false);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: `Failed to ${isRunning ? "pause" : "start"} sandbox`
			);
		} finally {
			setPendingSandboxAction(null);
		}
	};

	const handleCopySandboxId = async () => {
		if (!sandboxId) {
			toast.error("Sandbox ID not available");
			return;
		}

		try {
			await navigator.clipboard.writeText(sandboxId);
			toast.success("Copied sandbox ID");
			setOpen(false);
		} catch {
			toast.error("Failed to copy sandbox ID");
		}
	};

	return (
		<Popover onOpenChange={handleOpenChange} open={open}>
			<Tooltip>
				<Button
					aria-label="Open sandbox controls"
					render={<PopoverTrigger render={<TooltipTrigger />} />}
					size="icon-sm"
					variant="ghost"
				>
					<BoxIcon />
					<span className="sr-only">Sandbox controls</span>
				</Button>
				<TooltipContent side="bottom">Sandbox controls</TooltipContent>
			</Tooltip>
			<PopoverContent align="end" className="w-[22rem] gap-0 p-0">
				<PopoverHeader>
					<div className="flex items-start justify-between gap-3 px-3 pt-3">
						<div>
							<div className="flex items-center gap-1">
								<PopoverTitle>Sandbox</PopoverTitle>
								<TooltipIconButton
									aria-label="Copy sandbox ID"
									className="size-5 p-0.5 text-muted-foreground"
									disabled={!sandboxId}
									onClick={handleCopySandboxId}
									side="top"
									tooltip="Copy sandbox ID"
								>
									<CopyIcon className="size-3" />
								</TooltipIconButton>
							</div>
							<PopoverDescription>{statusCopy.description}</PopoverDescription>
						</div>
						<div className="inline-flex items-center gap-1.5 border border-border px-2 py-1 font-medium text-[11px] uppercase tracking-[0.08em]">
							<span className={statusCopy.dotClassName} />
							{statusCopy.label}
						</div>
					</div>
				</PopoverHeader>
				<div className="flex flex-col p-2">
					{(isRunning || showStartButton || isStarting) && (
						<Button
							className="justify-start"
							disabled={!canToggleSandbox || isUpdatingSandbox}
							onClick={handleToggleSandbox}
							size="sm"
							variant="ghost"
						>
							{isUpdatingSandbox || isStarting ? (
								<LoaderCircleIcon className="animate-spin" />
							) : isRunning ? (
								<PauseIcon />
							) : (
								<PlayIcon />
							)}
							{isUpdatingSandbox || isStarting
								? pendingSandboxAction === "pause"
									? "Pausing sandbox"
									: "Starting sandbox"
								: isRunning
									? "Pause sandbox"
									: "Start sandbox"}
						</Button>
					)}
					<Button
						className="justify-start"
						onClick={() => setIsSnapshotFormOpen((current) => !current)}
						size="sm"
						variant="ghost"
					>
						<CameraIcon />
						Create snapshot
						<ChevronDownIcon
							className={`ml-auto transition-transform ${isSnapshotFormOpen ? "rotate-180" : ""}`}
						/>
					</Button>
					{isSnapshotFormOpen && (
						<div className="mt-2 flex flex-col gap-3 border border-border bg-muted/20 p-3">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor={labelId}>Label</Label>
								<Input
									id={labelId}
									onChange={(event) => setLabel(event.target.value)}
									placeholder="Working setup"
									value={label}
								/>
							</div>
							<div className="flex items-start gap-2">
								<Checkbox
									checked={makeDefault}
									id={defaultId}
									onCheckedChange={(checked) =>
										setMakeDefault(checked === true)
									}
								/>
								<div className="flex flex-col gap-1">
									<Label htmlFor={defaultId}>Make default snapshot</Label>
									<p className="text-muted-foreground text-xs/relaxed">
										New spaces for this project will start from this snapshot.
									</p>
								</div>
							</div>
							<div className="flex justify-end">
								<Button
									disabled={!canCreateSnapshot}
									onClick={handleCreate}
									size="sm"
								>
									Create
								</Button>
							</div>
						</div>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}

function getSandboxStatusCopy(
	status: NonNullable<CreateSnapshotPopoverProps["status"]>
) {
	switch (status) {
		case "running":
			return {
				description:
					"Pause the live sandbox or capture a snapshot of its current state.",
				dotClassName: "size-2 rounded-full bg-emerald-500",
				label: "Running",
			};
		case "creating":
			return {
				description:
					"The sandbox is starting. You can create a snapshot once it finishes booting.",
				dotClassName: "size-2 rounded-full bg-amber-500",
				label: "Starting",
			};
		case "killed":
			return {
				description:
					"The sandbox is offline. Start it again or restore from a snapshot.",
				dotClassName: "size-2 rounded-full bg-muted-foreground/70",
				label: "Stopped",
			};
		case "error":
			return {
				description:
					"The last sandbox operation failed. Start it again or capture a new snapshot if one is still available.",
				dotClassName: "size-2 rounded-full bg-destructive",
				label: "Error",
			};
		default:
			return {
				description:
					"Start the sandbox when you need terminal or desktop access, or capture a snapshot from the current sandbox.",
				dotClassName: "size-2 rounded-full bg-amber-500",
				label: "Paused",
			};
	}
}
