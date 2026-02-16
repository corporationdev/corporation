import { useCallback, useEffect, useRef } from "react";
import { useTerminalStore } from "@/stores/terminal-store";

export function ResizeHandle() {
	const setPanelHeight = useTerminalStore((s) => s.setPanelHeight);
	const draggingRef = useRef(false);
	const startYRef = useRef(0);
	const startHeightRef = useRef(0);

	const onPointerDown = useCallback((e: React.PointerEvent) => {
		e.preventDefault();
		draggingRef.current = true;
		startYRef.current = e.clientY;
		startHeightRef.current = useTerminalStore.getState().panelHeight;
		document.body.style.cursor = "row-resize";
		document.body.style.userSelect = "none";
	}, []);

	useEffect(() => {
		const onPointerMove = (e: PointerEvent) => {
			if (!draggingRef.current) {
				return;
			}
			const delta = startYRef.current - e.clientY;
			setPanelHeight(startHeightRef.current + delta);
		};

		const onPointerUp = () => {
			if (!draggingRef.current) {
				return;
			}
			draggingRef.current = false;
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};

		document.addEventListener("pointermove", onPointerMove);
		document.addEventListener("pointerup", onPointerUp);
		return () => {
			document.removeEventListener("pointermove", onPointerMove);
			document.removeEventListener("pointerup", onPointerUp);
		};
	}, [setPanelHeight]);

	return (
		<div
			className="h-1 shrink-0 cursor-row-resize border-t bg-background transition-colors hover:bg-muted"
			onPointerDown={onPointerDown}
		/>
	);
}
