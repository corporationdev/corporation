import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTermTerminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef } from "react";
import { softResetActorConnectionOnTransientError } from "@/lib/actor-errors";
import type { SpaceActor } from "@/lib/rivetkit";
import "@xterm/xterm/css/xterm.css";

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ESC sequence for terminal mouse tracking
const MOUSE_TRACKING_RE = /\x1b\[\?100[0-6][hl]/g;

type TerminalViewProps = {
	terminalId: string;
	actor: SpaceActor;
};

type SpaceConnection = NonNullable<SpaceActor["connection"]>;

type TerminalDimensions = {
	cols: number;
	rows: number;
};

function getSpaceSlug(actor: SpaceActor): string | undefined {
	const key = actor.opts.key;
	if (typeof key === "string") {
		return key || undefined;
	}
	return key[0];
}

function handleTerminalActionError(
	error: unknown,
	terminalId: string,
	spaceSlug: string | undefined,
	action: string
): void {
	const kind = softResetActorConnectionOnTransientError({
		error,
		reasonPrefix: `terminal-${action}`,
		spaceSlug,
	});
	if (kind) {
		return;
	}
	console.error(`Failed to ${action} terminal action`, { error, terminalId });
}

export function TerminalView({ actor, terminalId }: TerminalViewProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<XTermTerminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const spaceSlug = getSpaceSlug(actor);
	const terminalReadyRef = useRef(false);
	const activeSubscriptionRef = useRef<{
		conn: SpaceConnection;
		terminalId: string;
	} | null>(null);
	const openAttemptRef = useRef(0);
	const pendingResizeRef = useRef<TerminalDimensions | null>(null);
	const lastResizeSentRef = useRef<TerminalDimensions | null>(null);
	const resizeFrameRef = useRef<number | null>(null);

	const handleActionError = useCallback(
		(error: unknown, failedTerminalId: string, action: string) => {
			handleTerminalActionError(error, failedTerminalId, spaceSlug, action);
		},
		[spaceSlug]
	);

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
				conn
					.resize(terminalId, next.cols, next.rows)
					.catch((error) => handleActionError(error, terminalId, "resize"));
			});
		},
		[handleActionError, terminalId]
	);

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
		const conn = actor.connection;

		const dataDisposable = terminal.onData((data) => {
			if (!terminalReadyRef.current) {
				return;
			}
			const bytes = Array.from(new TextEncoder().encode(data));
			conn
				.input(terminalId, bytes)
				.catch((error) => handleActionError(error, terminalId, "input"));
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
	}, [actor.connection, handleActionError, queueResize, terminalId]);

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
			conn
				.input(terminalId, bytes)
				.catch((error) => handleActionError(error, terminalId, "wheel-input"));
		};

		container.addEventListener("wheel", handleWheel, {
			capture: true,
			passive: false,
		});
		return () =>
			container.removeEventListener("wheel", handleWheel, { capture: true });
	}, [actor.connection, handleActionError, terminalId]);

	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			terminalReadyRef.current = false;
			return;
		}
		const conn = actor.connection;
		const previous = activeSubscriptionRef.current;

		// Connection churn can trigger duplicate open/unsubscribe loops. Keep a
		// single active subscription per (connection, terminalId).
		if (
			previous &&
			(previous.conn !== conn || previous.terminalId !== terminalId)
		) {
			previous.conn.unsubscribeTerminal(previous.terminalId).catch((error) => {
				handleActionError(error, previous.terminalId, "unsubscribe");
			});
			activeSubscriptionRef.current = null;
		}

		if (
			activeSubscriptionRef.current &&
			activeSubscriptionRef.current.conn === conn &&
			activeSubscriptionRef.current.terminalId === terminalId
		) {
			return;
		}

		const initialize = async () => {
			const openAttempt = openAttemptRef.current + 1;
			openAttemptRef.current = openAttempt;
			terminalReadyRef.current = false;

			try {
				const terminal = terminalRef.current;
				const dims =
					terminal && terminal.cols > 0 && terminal.rows > 0
						? { cols: terminal.cols, rows: terminal.rows }
						: null;

				await conn.openTerminal(terminalId, terminal?.cols, terminal?.rows);

				if (openAttemptRef.current !== openAttempt) {
					return;
				}

				activeSubscriptionRef.current = { conn, terminalId };
				terminalReadyRef.current = true;

				const latestDims = pendingResizeRef.current ?? dims;
				if (latestDims) {
					queueResize(conn, latestDims.cols, latestDims.rows);
				}
			} catch (error: unknown) {
				handleActionError(error, terminalId, "initialize");
			}
		};
		initialize().catch((error: unknown) => {
			handleActionError(error, terminalId, "initialize");
		});
	}, [
		actor.connStatus,
		actor.connection,
		handleActionError,
		queueResize,
		terminalId,
	]);

	useEffect(() => {
		return () => {
			terminalReadyRef.current = false;
			if (resizeFrameRef.current !== null) {
				cancelAnimationFrame(resizeFrameRef.current);
				resizeFrameRef.current = null;
			}

			const active = activeSubscriptionRef.current;
			activeSubscriptionRef.current = null;
			if (!active) {
				return;
			}

			active.conn
				.unsubscribeTerminal(active.terminalId)
				.catch((error: unknown) => {
					handleActionError(error, active.terminalId, "unsubscribe");
				});
		};
	}, [handleActionError]);

	// Strip mouse tracking escape sequences from tmux output so xterm.js
	// doesn't enter mouse-reporting mode. This lets xterm.js handle text
	// selection natively while we forward wheel events manually above.
	actor.useEvent("terminal.output", (payload: unknown) => {
		const event = payload as {
			terminalId: string;
			data: number[];
			snapshot?: boolean;
		};
		if (event.terminalId !== terminalId) {
			return;
		}
		const raw = new Uint8Array(event.data);
		const text = new TextDecoder().decode(raw);
		const filtered = text.replace(MOUSE_TRACKING_RE, "");
		const output = event.snapshot
			? filtered.replace(/\r?\n/g, "\r\n")
			: filtered;
		if (event.snapshot) {
			terminalRef.current?.reset();
		}
		terminalRef.current?.write(
			output === text ? raw : new TextEncoder().encode(output)
		);
	});

	return (
		<div className="h-full w-full bg-[#0a0a0a] px-2 py-1" ref={containerRef} />
	);
}
