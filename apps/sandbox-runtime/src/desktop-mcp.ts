/**
 * Desktop MCP server — exposes xdotool / ImageMagick tools over stdio.
 *
 * Invoked as: sandbox-runtime mcp desktop
 */

import { execFile } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DISPLAY = ":0";
const ENV = { ...process.env, DISPLAY };

function run(
	command: string,
	args: string[]
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{ env: ENV, timeout: 30_000 },
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error(`${command} failed: ${stderr || error.message}`));
				} else {
					resolve({ stdout, stderr });
				}
			}
		);
	});
}

function shell(cmd: string): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(
			"bash",
			["-c", cmd],
			{ env: ENV, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error(`Command failed: ${stderr || error.message}`));
				} else {
					resolve({ stdout, stderr });
				}
			}
		);
	});
}

export async function runDesktopMcp(): Promise<void> {
	const server = new McpServer({
		name: "desktop",
		version: "1.0.1",
	});

	server.registerTool(
		"screenshot",
		{
			description:
				"Take a screenshot of the desktop and return it as a base64-encoded PNG image",
			inputSchema: {},
		},
		async () => {
			// Capture as JPEG to keep payload small (no resize — coordinates must match the real desktop)
			const { stdout } = await shell(
				"import -window root -quality 60 jpeg:/tmp/_desktop_mcp_screenshot.jpg && base64 -w 0 /tmp/_desktop_mcp_screenshot.jpg && rm -f /tmp/_desktop_mcp_screenshot.jpg"
			);
			if (!stdout || stdout.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "Screenshot failed: display may not be running",
						},
					],
				};
			}
			return {
				content: [{ type: "image", data: stdout, mimeType: "image/jpeg" }],
			};
		}
	);

	server.registerTool(
		"click",
		{
			description: "Move the mouse to (x, y) and left-click",
			inputSchema: {
				x: z.number().describe("X coordinate"),
				y: z.number().describe("Y coordinate"),
			},
		},
		async ({ x, y }) => {
			await run("xdotool", [
				"mousemove",
				"--sync",
				String(x),
				String(y),
				"click",
				"1",
			]);
			return { content: [{ type: "text", text: `Clicked at (${x}, ${y})` }] };
		}
	);

	server.registerTool(
		"double_click",
		{
			description: "Move the mouse to (x, y) and double-click",
			inputSchema: {
				x: z.number().describe("X coordinate"),
				y: z.number().describe("Y coordinate"),
			},
		},
		async ({ x, y }) => {
			await run("xdotool", [
				"mousemove",
				"--sync",
				String(x),
				String(y),
				"click",
				"--repeat",
				"2",
				"1",
			]);
			return {
				content: [{ type: "text", text: `Double-clicked at (${x}, ${y})` }],
			};
		}
	);

	server.registerTool(
		"right_click",
		{
			description: "Move the mouse to (x, y) and right-click",
			inputSchema: {
				x: z.number().describe("X coordinate"),
				y: z.number().describe("Y coordinate"),
			},
		},
		async ({ x, y }) => {
			await run("xdotool", [
				"mousemove",
				"--sync",
				String(x),
				String(y),
				"click",
				"3",
			]);
			return {
				content: [{ type: "text", text: `Right-clicked at (${x}, ${y})` }],
			};
		}
	);

	server.registerTool(
		"type_text",
		{
			description: "Type text using the keyboard (simulates keypresses)",
			inputSchema: {
				text: z.string().describe("Text to type"),
			},
		},
		async ({ text }) => {
			await run("xdotool", ["type", "--", text]);
			return { content: [{ type: "text", text: `Typed: ${text}` }] };
		}
	);

	server.registerTool(
		"key",
		{
			description:
				"Press a key or key combination (e.g. 'Return', 'ctrl+c', 'alt+F4')",
			inputSchema: {
				key: z.string().describe("Key or key combination to press"),
			},
		},
		async ({ key }) => {
			await run("xdotool", ["key", key]);
			return { content: [{ type: "text", text: `Pressed key: ${key}` }] };
		}
	);

	server.registerTool(
		"scroll",
		{
			description: "Move the mouse to (x, y) and scroll up or down",
			inputSchema: {
				x: z.number().describe("X coordinate"),
				y: z.number().describe("Y coordinate"),
				direction: z.enum(["up", "down"]).describe("Scroll direction"),
				amount: z
					.number()
					.int()
					.min(1)
					.default(3)
					.describe("Number of scroll clicks"),
			},
		},
		async ({ x, y, direction, amount }) => {
			const button = direction === "up" ? "4" : "5";
			await run("xdotool", [
				"mousemove",
				"--sync",
				String(x),
				String(y),
				"click",
				"--repeat",
				String(amount),
				button,
			]);
			return {
				content: [
					{
						type: "text",
						text: `Scrolled ${direction} ${amount}x at (${x}, ${y})`,
					},
				],
			};
		}
	);

	server.registerTool(
		"cursor_position",
		{
			description: "Get the current mouse cursor position",
			inputSchema: {},
		},
		async () => {
			const { stdout } = await run("xdotool", ["getmouselocation"]);
			return { content: [{ type: "text", text: stdout.trim() }] };
		}
	);

	const transport = new StdioServerTransport();
	await server.connect(transport);
}
