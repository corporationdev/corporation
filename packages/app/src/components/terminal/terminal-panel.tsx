import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useActor } from "@/lib/rivetkit";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";

type TerminalPanelProps = {
	sandboxId: string;
};

export function TerminalPanel({ sandboxId }: TerminalPanelProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const actor = useActor({
		name: "terminal",
		key: [sandboxId],
		createWithInput: { sandboxId },
		enabled: true,
	});

	// Initialize xterm.js
	useEffect(() => {
		const container = containerRef.current;
		if (!container) {
			return;
		}

		const terminal = new Terminal({
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

		// Initial fit
		requestAnimationFrame(() => fitAddon.fit());

		terminalRef.current = terminal;
		fitAddonRef.current = fitAddon;

		// Resize observer to keep terminal fitted
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

	// Wire terminal input and resize -> actor
	useEffect(() => {
		const terminal = terminalRef.current;
		if (!(terminal && actor.connection)) {
			return;
		}

		const dataDisposable = terminal.onData((data) => {
			const bytes = Array.from(new TextEncoder().encode(data));
			actor.connection?.input(bytes);
		});

		const resizeDisposable = terminal.onResize(({ cols, rows }) => {
			actor.connection?.resize(cols, rows);
		});

		// Send initial resize so the server knows our dimensions
		actor.connection.resize(terminal.cols, terminal.rows);

		return () => {
			dataDisposable.dispose();
			resizeDisposable.dispose();
		};
	}, [actor.connection]);

	// Replay scrollback buffer on connect, then stream live output
	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			return;
		}

		// Replay scrollback history
		actor.connection.getScrollback().then((data: number[]) => {
			if (data.length > 0) {
				terminalRef.current?.write(new Uint8Array(data));
			}
		});

		const unsubscribe = actor.connection.on("output", (data: number[]) => {
			terminalRef.current?.write(new Uint8Array(data));
		});

		return unsubscribe;
	}, [actor.connStatus, actor.connection]);

	return (
		<div className="h-full w-full bg-[#0a0a0a] px-2 py-1" ref={containerRef} />
	);
}
