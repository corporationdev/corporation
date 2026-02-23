import { PanelRightIcon } from "lucide-react";
import type { FC } from "react";
import { Button } from "@/components/ui/button";
import { useSpaceSidebarStore } from "@/stores/space-sidebar-store";

export const SpaceSidebarToggle: FC = () => {
	const setIsOpen = useSpaceSidebarStore((s) => s.setIsOpen);
	const isOpen = useSpaceSidebarStore((s) => s.isOpen);

	return (
		<Button
			data-active={isOpen}
			onClick={() => setIsOpen(!isOpen)}
			size="icon-sm"
			variant="ghost"
		>
			<PanelRightIcon />
		</Button>
	);
};
