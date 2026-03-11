import { useMutation } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { clearTokenCache } from "@/lib/api-client";
import { createOrganizationFromName } from "@/lib/organization";

export function CreateOrganizationDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [name, setName] = useState("");
	const createOrganizationMutation = useMutation({
		mutationFn: async () => {
			return await createOrganizationFromName(name);
		},
		onSuccess: () => {
			toast.success("Organization created");
			onOpenChange(false);
			setName("");
			clearTokenCache();
			window.location.assign("/");
		},
		onError: (error) => {
			toast.error(error.message);
		},
	});

	return (
		<Dialog
			onOpenChange={(nextOpen) => {
				onOpenChange(nextOpen);
				if (!nextOpen) {
					setName("");
				}
			}}
			open={open}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Create organization</DialogTitle>
					<DialogDescription>
						Create a new organization and switch into it immediately.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-2">
					<Input
						autoFocus
						onChange={(event) => setName(event.target.value)}
						placeholder="Acme"
						value={name}
					/>
				</div>
				<DialogFooter>
					<Button
						disabled={createOrganizationMutation.isPending || !name.trim()}
						onClick={() => createOrganizationMutation.mutate()}
					>
						{createOrganizationMutation.isPending ? (
							<Loader2 className="animate-spin" />
						) : (
							<Plus />
						)}
						Create organization
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
