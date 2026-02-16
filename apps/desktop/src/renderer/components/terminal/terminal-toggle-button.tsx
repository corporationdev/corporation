import { api } from "@corporation/backend/convex/_generated/api";
import { useQuery } from "convex/react";
import { TerminalIcon } from "lucide-react";
import type { FC } from "react";
import { Button } from "@/components/ui/button";
import { useTerminalStore } from "@/stores/terminal-store";

export const TerminalToggleButton: FC<{ slug: string }> = ({ slug }) => {
	const session = useQuery(api.agentSessions.getBySlug, { slug });
	const setOpen = useTerminalStore((s) => s.setOpen);
	const isOpen = useTerminalStore((s) => s.isOpen);

	if (!session?.space.sandboxId) {
		return null;
	}

	return (
		<Button
			data-active={isOpen}
			onClick={() => setOpen(!isOpen)}
			size="icon-sm"
			variant="ghost"
		>
			<TerminalIcon className="size-3.5" />
		</Button>
	);
};
