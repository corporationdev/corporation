import { TerminalIcon } from "lucide-react";
import type { FC } from "react";
import { Button } from "@/components/ui/button";
import { useTerminalStore } from "@/stores/terminal-store";

export const TerminalToggleButton: FC = () => {
	const setIsOpen = useTerminalStore((s) => s.setIsOpen);
	const isOpen = useTerminalStore((s) => s.isOpen);

	return (
		<Button
			data-active={isOpen}
			onClick={() => setIsOpen(!isOpen)}
			size="icon-sm"
			variant="ghost"
		>
			<TerminalIcon className="size-3.5" />
		</Button>
	);
};
