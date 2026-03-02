import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTermTerminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import type { SpaceActor } from "@/lib/rivetkit";
import "@xterm/xterm/css/xterm.css";

const MOUSE_TRACKING_RE = /\x1b\[\?100[0-6][hl]/g;

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

		// Let browser handle Cmd/Ctrl+C (when text selected) and Cmd/Ctrl+V
		terminal.attachCustomKeyEventHandler((event) => {
			if (event.type !== "keydown") {
				return true;
			}
			const isMeta = event.metaKey || event.ctrlKey;
			if (isMeta && event.key === "c" && terminal.hasSelection()) {
				return false;
			}
			if (isMeta && event.key === "v") {
				return false;
			}
			return true;
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

	// Forward keyboard input and resize events to the PTY
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

	// Intercept wheel events and send them as SGR mouse scroll sequences to
	// tmux (which has mouse on). We prevent xterm.js from seeing the wheel
	// event so it doesn't convert it to arrow-key input.
	useEffect(() => {
		const container = containerRef.current;
		if (!(container && actor.connection)) {
			return;
		}

		const conn = actor.connection;
		const handleWheel = (e: WheelEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const lines = Math.max(1, Math.ceil(Math.abs(e.deltaY) / 40));
			// SGR mouse: 64 = scroll up, 65 = scroll down
			const button = e.deltaY > 0 ? 65 : 64;
			const seq = `\x1b[<${button};1;1M`.repeat(lines);
			const bytes = Array.from(new TextEncoder().encode(seq));
			conn.input(terminalId, bytes);
		};

		container.addEventListener("wheel", handleWheel, {
			capture: true,
			passive: false,
		});
		return () =>
			container.removeEventListener("wheel", handleWheel, { capture: true });
	}, [actor.connection, terminalId]);

	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			return;
		}

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
			} catch (error: unknown) {
				console.error("Failed to initialize terminal", error);
			}
		};
		initialize().catch((error: unknown) => {
			console.error("Failed to initialize terminal", error);
		});

		return () => {
			actor.connection
				?.unsubscribeTerminal(terminalId)
				.catch((error: unknown) => {
					console.error("Failed to unsubscribe terminal", error);
				});
		};
	}, [actor.connStatus, actor.connection, terminalId]);

	// Strip mouse tracking escape sequences from tmux output so xterm.js
	// doesn't enter mouse-reporting mode. This lets xterm.js handle text
	// selection natively while we forward wheel events manually above.
	actor.useEvent("terminal.output", (payload: unknown) => {
		const event = payload as { terminalId: string; data: number[] };
		if (event.terminalId !== terminalId) {
			return;
		}
		const raw = new Uint8Array(event.data);
		const text = new TextDecoder().decode(raw);
		const filtered = text.replace(MOUSE_TRACKING_RE, "");
		terminalRef.current?.write(
			filtered.length !== text.length ? new TextEncoder().encode(filtered) : raw
		);
	});

	return (
		<div className="h-full w-full bg-[#0a0a0a] px-2 py-1" ref={containerRef} />
	);
}
