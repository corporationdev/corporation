import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useActor } from "@/lib/rivetkit";
import { useTerminalStore } from "@/stores/terminal-store";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef } from "react";

type TerminalPanelProps = {
	sandboxId: string;
	sandboxUrl: string;
};

export function TerminalPanel({ sandboxId, sandboxUrl }: TerminalPanelProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const panelHeight = useTerminalStore((s) => s.panelHeight);

	const actor = useActor({
		name: "terminal",
		key: [sandboxId],
		createWithInput: { sandboxId, sandboxUrl },
		enabled: true,
	});

	// Send resize to the actor when terminal dimensions change
	const sendResize = useCallback(() => {
		const terminal = terminalRef.current;
		if (!(terminal && actor.connection)) {
			return;
		}
		actor.connection.resize(terminal.cols, terminal.rows);
	}, [actor.connection]);

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

	// Refit when panel height changes and send new dimensions to actor.
	// panelHeight is read inside the effect to satisfy exhaustive-deps while
	// still triggering on height changes.
	useEffect(() => {
		// panelHeight triggers the effect — the ResizeObserver doesn't fire
		// for programmatic height changes on the parent div.
		const _height = panelHeight;
		const fitAddon = fitAddonRef.current;
		if (!fitAddon) {
			return;
		}
		requestAnimationFrame(() => {
			fitAddon.fit();
			sendResize();
		});
	}, [panelHeight, sendResize]);

	// Wire terminal input -> actor
	useEffect(() => {
		const terminal = terminalRef.current;
		if (!(terminal && actor.connection)) {
			return;
		}

		const disposable = terminal.onData((data) => {
			const bytes = Array.from(new TextEncoder().encode(data));
			actor.connection?.input(bytes);
		});

		// Send initial resize so the server knows our dimensions
		sendResize();

		return () => disposable.dispose();
	}, [actor.connection, sendResize]);

	// Wire actor output -> terminal
	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			return;
		}

		const unsubscribe = actor.connection.on("output", (data: number[]) => {
			terminalRef.current?.write(new Uint8Array(data));
		});

		return unsubscribe;
	}, [actor.connStatus, actor.connection]);

	return (
		<div className="h-full w-full bg-[#0a0a0a] px-2 py-1" ref={containerRef} />
	);
}
