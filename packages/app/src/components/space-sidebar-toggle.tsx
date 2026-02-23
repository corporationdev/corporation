import { PanelRightIcon } from "lucide-react";
import type { FC } from "react";
import { Button } from "@/components/ui/button";
import { useLayoutStore } from "@/stores/layout-store";

export const SpaceSidebarToggle: FC = () => {
	const setIsOpen = useLayoutStore((s) => s.setRightSidebarOpen);
	const isOpen = useLayoutStore((s) => s.rightSidebarOpen);

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
