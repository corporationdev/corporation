import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTermTerminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import type { SpaceActor } from "@/lib/rivetkit";
import "@xterm/xterm/css/xterm.css";

type TerminalViewProps = {
	terminalId: string;
	actor: SpaceActor;
};

export function TerminalView({ actor, terminalId }: TerminalViewProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<XTermTerminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) {
			return;
		}

		const terminal = new XTermTerminal({
			cursorBlink: true,
			fontSize: 13,
			fontFamily: "monospace",
			theme: {
				background: "#0a0a0a",
				foreground: "#e5e5e5",
				cursor: "#e5e5e5",
			},
		});

		const fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);
		terminal.loadAddon(new WebLinksAddon());
		terminal.open(container);

		requestAnimationFrame(() => fitAddon.fit());

		terminalRef.current = terminal;
		fitAddonRef.current = fitAddon;

		const observer = new ResizeObserver(() => {
			requestAnimationFrame(() => fitAddon.fit());
		});
		observer.observe(container);

		return () => {
			observer.disconnect();
			terminal.dispose();
			terminalRef.current = null;
			fitAddonRef.current = null;
		};
	}, []);

	useEffect(() => {
		const terminal = terminalRef.current;
		if (!(terminal && actor.connection)) {
			return;
		}

		const dataDisposable = terminal.onData((data) => {
			const bytes = Array.from(new TextEncoder().encode(data));
			actor.connection?.input(terminalId, bytes);
		});

		const resizeDisposable = terminal.onResize(({ cols, rows }) => {
			actor.connection?.resize(terminalId, cols, rows);
		});

		return () => {
			dataDisposable.dispose();
			resizeDisposable.dispose();
		};
	}, [actor.connection, terminalId]);

	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			return;
		}

		let isCancelled = false;
		const initialize = async () => {
			try {
				await actor.connection?.subscribeTerminal(terminalId);

				const terminal = terminalRef.current;
				if (terminal) {
					await actor.connection?.resize(
						terminalId,
						terminal.cols,
						terminal.rows
					);
				}

				const data = await actor.connection?.getScrollback(terminalId);
				if (isCancelled || !data || data.length === 0) {
					return;
				}
				terminalRef.current?.write(new Uint8Array(data));
			} catch (error: unknown) {
				console.error("Failed to initialize terminal", error);
			}
		};
		initialize().catch((error: unknown) => {
			console.error("Failed to initialize terminal", error);
		});

		return () => {
			isCancelled = true;
			actor.connection
				?.unsubscribeTerminal(terminalId)
				.catch((error: unknown) => {
					console.error("Failed to unsubscribe terminal", error);
				});
		};
	}, [actor.connStatus, actor.connection, terminalId]);

	actor.useEvent("terminal.output", (payload: unknown) => {
		const event = payload as { terminalId: string; data: number[] };
		if (event.terminalId !== terminalId) {
			return;
		}
		terminalRef.current?.write(new Uint8Array(event.data));
	});

	return (
		<div className="h-full w-full bg-[#0a0a0a] px-2 py-1" ref={containerRef} />
	);
}
