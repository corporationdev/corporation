import { api } from "@corporation/backend/convex/_generated/api";
import type { Id } from "@corporation/backend/convex/_generated/dataModel";
import { useMutation } from "convex/react";
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

type CreateSnapshotPopoverProps = {
	spaceId: Id<"spaces"> | undefined;
	sandboxId: string | undefined;
};

export function CreateSnapshotPopover({
	spaceId,
	sandboxId,
}: CreateSnapshotPopoverProps) {
	const [open, setOpen] = useState(false);
	const [label, setLabel] = useState("");
	const [makeDefault, setMakeDefault] = useState(false);
	const labelId = useId();
	const defaultId = useId();
	const createSnapshot = useMutation(api.snapshot.createFromSpace);

	const handleCreate = async () => {
		if (!(spaceId && sandboxId)) {
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
			setLabel("");
			setMakeDefault(false);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to create snapshot"
			);
		}
	};

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger render={<Button size="sm" variant="outline" />}>
				Create snapshot
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80 gap-3">
				<PopoverHeader>
					<PopoverTitle>Create snapshot</PopoverTitle>
					<PopoverDescription>
						Capture the current sandbox with a label and optionally use it as
						the default for new spaces.
					</PopoverDescription>
				</PopoverHeader>
				<div className="flex flex-col gap-3">
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
							onCheckedChange={(checked) => setMakeDefault(checked === true)}
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
							disabled={!(spaceId && sandboxId)}
							onClick={handleCreate}
							size="sm"
						>
							Create
						</Button>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
}
