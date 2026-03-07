import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTermTerminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef } from "react";
import type { SpaceActor } from "@/lib/rivetkit";
import "@xterm/xterm/css/xterm.css";

type TerminalTabProps = {
	actor: SpaceActor;
	spaceSlug: string;
};

type SpaceConnection = NonNullable<SpaceActor["connection"]>;

export function TerminalTab({ actor, spaceSlug }: TerminalTabProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<XTermTerminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const terminalReadyRef = useRef(false);
	const openedOnConnRef = useRef<SpaceConnection | null>(null);
	const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
	const lastResizeSentRef = useRef<{ cols: number; rows: number } | null>(null);
	const resizeFrameRef = useRef<number | null>(null);

	const queueResize = useCallback(
		(conn: SpaceConnection, cols: number, rows: number): void => {
			pendingResizeRef.current = { cols, rows };
			if (resizeFrameRef.current !== null) {
				return;
			}

			resizeFrameRef.current = requestAnimationFrame(() => {
				resizeFrameRef.current = null;
				if (!terminalReadyRef.current) {
					return;
				}

				const next = pendingResizeRef.current;
				if (!next) {
					return;
				}

				const last = lastResizeSentRef.current;
				if (last && last.cols === next.cols && last.rows === next.rows) {
					return;
				}

				lastResizeSentRef.current = next;
				conn.resize(next.cols, next.rows).catch((e) => {
					console.error("Failed to resize terminal action", {
						error: e,
						spaceSlug,
					});
				});
			});
		},
		[spaceSlug]
	);

	// Initialize xterm.js
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

	// Forward keyboard input and resize to PTY
	useEffect(() => {
		const terminal = terminalRef.current;
		if (!(terminal && actor.connection)) {
			return;
		}
		const conn = actor.connection;

		const dataDisposable = terminal.onData((data) => {
			if (!terminalReadyRef.current) {
				return;
			}
			const bytes = Array.from(new TextEncoder().encode(data));
			conn.input(bytes).catch((e) => {
				console.error("Failed to input terminal action", { error: e, spaceSlug });
			});
		});

		const resizeDisposable = terminal.onResize(({ cols, rows }) => {
			pendingResizeRef.current = { cols, rows };
			if (!terminalReadyRef.current) {
				return;
			}
			queueResize(conn, cols, rows);
		});

		return () => {
			dataDisposable.dispose();
			resizeDisposable.dispose();
			if (resizeFrameRef.current !== null) {
				cancelAnimationFrame(resizeFrameRef.current);
				resizeFrameRef.current = null;
			}
		};
	}, [actor.connection, queueResize, spaceSlug]);

	// Open terminal on connect
	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			terminalReadyRef.current = false;
			return;
		}
		const conn = actor.connection;

		if (openedOnConnRef.current === conn) {
			return;
		}

		const initialize = async () => {
			terminalReadyRef.current = false;
			const terminal = terminalRef.current;
			const dims =
				terminal && terminal.cols > 0 && terminal.rows > 0
					? { cols: terminal.cols, rows: terminal.rows }
					: null;

			await conn.openTerminal(dims?.cols, dims?.rows);

			openedOnConnRef.current = conn;
			terminalReadyRef.current = true;

			const latestDims = pendingResizeRef.current ?? dims;
			if (latestDims) {
				queueResize(conn, latestDims.cols, latestDims.rows);
			}
		};

		initialize().catch((e) => {
			console.error("Failed to initialize terminal action", {
				error: e,
				spaceSlug,
			});
		});
	}, [actor.connStatus, actor.connection, queueResize, spaceSlug]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			terminalReadyRef.current = false;
			if (resizeFrameRef.current !== null) {
				cancelAnimationFrame(resizeFrameRef.current);
				resizeFrameRef.current = null;
			}
			const conn = openedOnConnRef.current;
			openedOnConnRef.current = null;
			if (conn) {
				conn.closeTerminal().catch((e: unknown) => {
					console.error("Failed to close terminal action", {
						error: e,
						spaceSlug,
					});
				});
			}
		};
	}, [spaceSlug]);

	// Receive terminal output
	actor.useEvent("terminal.output", (payload: unknown) => {
		const event = payload as {
			terminalId: string;
			data: number[];
			snapshot?: boolean;
		};
		const raw = new Uint8Array(event.data);
		if (event.snapshot) {
			terminalRef.current?.reset();
			const text = new TextDecoder().decode(raw);
			terminalRef.current?.write(text.replace(/\r?\n/g, "\r\n"));
		} else {
			terminalRef.current?.write(raw);
		}
	});

	return (
		<div className="h-full w-full bg-[#0a0a0a] px-2 py-1" ref={containerRef} />
	);
}
