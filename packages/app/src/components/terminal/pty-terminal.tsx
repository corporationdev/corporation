import { FitAddon, Terminal as GhosttyTerminal, init } from "ghostty-web";
import { useCallback, useEffect, useRef, useState } from "react";
import { type SpaceActor, useSpaceEvent } from "@/lib/space-client";

type PtyTerminalProps = {
	actor: SpaceActor;
	spaceSlug: string;
};

type SpaceConnection = NonNullable<SpaceActor["connection"]>;

let ghosttyInitPromise: Promise<void> | null = null;
const URL_SCHEME_REGEX =
	/(?:https?:\/\/|mailto:|ftp:\/\/|ssh:\/\/|git:\/\/|tel:|magnet:|gemini:\/\/|gopher:\/\/|news:)/i;
const URL_FRAGMENT_START_REGEX = /^[A-Za-z0-9%/?#=&:+._~[\]-]/;
const URL_FRAGMENT_END_REGEX = /[A-Za-z0-9%/?#=&:+._~[\]-]$/;
const WHITESPACE_REGEX = /\s/;

function ensureGhosttyReady() {
	ghosttyInitPromise ??= init();
	return ghosttyInitPromise;
}

function shouldJoinUrlLine(
	currentLine: string,
	nextLine: string,
	inUrl: boolean
) {
	const current = currentLine.trimEnd();
	const next = nextLine.trim();
	if (!(current && next)) {
		return false;
	}

	if (!(inUrl || URL_SCHEME_REGEX.test(current))) {
		return false;
	}

	if (WHITESPACE_REGEX.test(current) || WHITESPACE_REGEX.test(next)) {
		return false;
	}

	return (
		URL_FRAGMENT_END_REGEX.test(current) && URL_FRAGMENT_START_REGEX.test(next)
	);
}

function normalizeCopiedText(text: string) {
	const lines = text.split("\n");
	if (lines.length <= 1) {
		return text;
	}

	const normalizedLines: string[] = [];
	let currentLine = lines[0] ?? "";
	let inUrl = URL_SCHEME_REGEX.test(currentLine);

	for (let i = 1; i < lines.length; i++) {
		const nextLine = lines[i] ?? "";
		if (shouldJoinUrlLine(currentLine, nextLine, inUrl)) {
			currentLine = `${currentLine.trimEnd()}${nextLine.trim()}`;
			inUrl = true;
			continue;
		}

		normalizedLines.push(currentLine);
		currentLine = nextLine;
		inUrl = URL_SCHEME_REGEX.test(currentLine);
	}

	normalizedLines.push(currentLine);
	return normalizedLines.join("\n");
}

function getNormalizedSelection(terminal: GhosttyTerminal | null) {
	if (!terminal?.hasSelection()) {
		return null;
	}

	const selection = normalizeCopiedText(terminal.getSelection());
	return selection.length > 0 ? selection : null;
}

async function writeTextToClipboard(text: string) {
	if (!navigator.clipboard?.writeText) {
		return;
	}

	try {
		await navigator.clipboard.writeText(text);
	} catch (error) {
		console.error("Failed to write terminal selection to clipboard", {
			error,
			textLength: text.length,
		});
	}
}

export function PtyTerminal({ actor, spaceSlug }: PtyTerminalProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<GhosttyTerminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const terminalReadyRef = useRef(false);
	const awaitingSnapshotRef = useRef(false);
	const openedOnConnRef = useRef<SpaceConnection | null>(null);
	const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
	const lastResizeSentRef = useRef<{ cols: number; rows: number } | null>(null);
	const resizeFrameRef = useRef<number | null>(null);
	const [terminalMounted, setTerminalMounted] = useState(false);

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

	useEffect(() => {
		const container = containerRef.current;
		if (!container) {
			return;
		}

		let cancelled = false;
		let terminal: GhosttyTerminal | null = null;
		let fitAddon: FitAddon | null = null;
		let observer: ResizeObserver | null = null;
		const handleCopy = (event: ClipboardEvent) => {
			const terminal = terminalRef.current;
			const selection = getNormalizedSelection(terminal);
			if (!selection) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			event.clipboardData?.setData("text/plain", selection);
			writeTextToClipboard(selection);
		};
		const handleKeyDown = (event: KeyboardEvent) => {
			if (
				!(
					event.key.toLowerCase() === "c" &&
					(event.metaKey || event.ctrlKey)
				) ||
				event.altKey
			) {
				return;
			}

			const selection = getNormalizedSelection(terminalRef.current);
			if (!selection) {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			writeTextToClipboard(selection);
		};
		const handleMouseDown = () => terminalRef.current?.focus();

		container.addEventListener("copy", handleCopy, true);
		container.addEventListener("keydown", handleKeyDown, true);
		container.addEventListener("mousedown", handleMouseDown);

		ensureGhosttyReady()
			.then(() => {
				if (cancelled) {
					return;
				}

				container.style.caretColor = "transparent";
				container.style.outline = "none";

				const createdTerminal = new GhosttyTerminal({
					cursorBlink: true,
					fontSize: 13,
					fontFamily: "monospace",
					theme: {
						background: "#0a0a0a",
						foreground: "#e5e5e5",
						cursor: "#e5e5e5",
					},
				});

				fitAddon = new FitAddon();
				createdTerminal.loadAddon(fitAddon);
				createdTerminal.open(container);
				createdTerminal.focus();

				requestAnimationFrame(() => fitAddon?.fit());

				terminal = createdTerminal;
				terminalRef.current = createdTerminal;
				fitAddonRef.current = fitAddon;
				setTerminalMounted(true);

				observer = new ResizeObserver(() => {
					requestAnimationFrame(() => fitAddon?.fit());
				});
				observer.observe(container);
			})
			.catch((error) => {
				console.error("Failed to initialize ghostty-web", {
					error,
					spaceSlug,
				});
			});

		return () => {
			cancelled = true;
			container.removeEventListener("copy", handleCopy, true);
			container.removeEventListener("keydown", handleKeyDown, true);
			container.removeEventListener("mousedown", handleMouseDown);
			observer?.disconnect();
			terminal?.dispose();
			terminalRef.current = null;
			fitAddonRef.current = null;
			setTerminalMounted(false);
		};
	}, [spaceSlug]);

	useEffect(() => {
		if (!terminalMounted) {
			return;
		}

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
				console.error("Failed to input terminal action", {
					error: e,
					spaceSlug,
				});
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
	}, [actor.connection, queueResize, spaceSlug, terminalMounted]);

	useEffect(() => {
		if (actor.connStatus !== "connected" || !actor.connection) {
			terminalReadyRef.current = false;
			awaitingSnapshotRef.current = false;
			return;
		}
		const conn = actor.connection;

		if (openedOnConnRef.current === conn) {
			return;
		}

		const initialize = async () => {
			terminalReadyRef.current = false;
			awaitingSnapshotRef.current = true;

			const snapshotSent = await conn.getTerminalSnapshot();

			openedOnConnRef.current = conn;
			if (snapshotSent) {
				return;
			}

			awaitingSnapshotRef.current = false;
			terminalReadyRef.current = true;

			const terminal = terminalRef.current;
			const dims =
				pendingResizeRef.current ??
				(terminal && terminal.cols > 0 && terminal.rows > 0
					? { cols: terminal.cols, rows: terminal.rows }
					: null);
			if (dims) {
				queueResize(conn, dims.cols, dims.rows);
			}
			terminal?.focus();
		};

		initialize().catch((e) => {
			console.error("Failed to initialize terminal", {
				error: e,
				spaceSlug,
			});
		});
	}, [actor.connStatus, actor.connection, queueResize, spaceSlug]);

	useSpaceEvent(actor, "terminal.output", (payload: unknown) => {
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
			if (awaitingSnapshotRef.current) {
				awaitingSnapshotRef.current = false;
				terminalReadyRef.current = true;

				const conn = actor.connection;
				const terminal = terminalRef.current;
				const dims =
					pendingResizeRef.current ??
					(terminal && terminal.cols > 0 && terminal.rows > 0
						? { cols: terminal.cols, rows: terminal.rows }
						: null);
				if (conn && dims) {
					queueResize(conn, dims.cols, dims.rows);
				}
				terminal?.focus();
			}
		} else {
			terminalRef.current?.write(raw);
		}
	});

	return (
		<div className="h-full w-full bg-[#0a0a0a] px-2 py-1" ref={containerRef} />
	);
}
