import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	getDefaultPosixWrapperPath,
	getDefaultWindowsWrapperPath,
} from "./runtime-state";

const LINUX_SERVICE_NAME = "tendril-cli.service";
const MAC_LABEL = "sh.tendril.cli";
const WINDOWS_TASK_NAME = "TendrilCli";

type InstallServiceInput = {
	command: string[];
	logPath: string;
};

function quotePosix(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function quoteWindows(value: string): string {
	return `"${value.replaceAll(`"`, `""`)}"`;
}

async function runCommand(command: string, args: string[]): Promise<string> {
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) {
				resolvePromise(stdout);
				return;
			}
			reject(
				new Error(
					`${command} ${args.join(" ")} failed with code ${code}\n${stderr || stdout}`
				)
			);
		});
	});
}

async function writePosixWrapper(command: string[]): Promise<string> {
	const path = getDefaultPosixWrapperPath();
	const content = `#!/bin/sh
exec ${command.map(quotePosix).join(" ")}
`;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, { encoding: "utf8", mode: 0o755 });
	return path;
}

async function writeWindowsWrapper(command: string[]): Promise<string> {
	const path = getDefaultWindowsWrapperPath();
	const content = `@echo off\r\n${command.map(quoteWindows).join(" ")}\r\n`;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
	return path;
}

async function installLinuxService(input: InstallServiceInput): Promise<void> {
	const wrapperPath = await writePosixWrapper(input.command);
	const unitPath = join(
		homedir(),
		".config",
		"systemd",
		"user",
		LINUX_SERVICE_NAME
	);
	const unit = `[Unit]
Description=Tendril CLI daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/bin/sh ${quotePosix(wrapperPath)}
Restart=always
RestartSec=5
WorkingDirectory=${quotePosix(homedir())}

[Install]
WantedBy=default.target
`;
	await mkdir(dirname(unitPath), { recursive: true });
	await writeFile(unitPath, unit, "utf8");
	await runCommand("systemctl", ["--user", "daemon-reload"]);
	await runCommand("systemctl", [
		"--user",
		"enable",
		"--now",
		LINUX_SERVICE_NAME,
	]);
}

async function uninstallLinuxService(): Promise<void> {
	const unitPath = join(
		homedir(),
		".config",
		"systemd",
		"user",
		LINUX_SERVICE_NAME
	);
	await runCommand("systemctl", [
		"--user",
		"disable",
		"--now",
		LINUX_SERVICE_NAME,
	]).catch(() => undefined);
	await rm(unitPath, { force: true });
	await runCommand("systemctl", ["--user", "daemon-reload"]).catch(
		() => undefined
	);
}

function getMacDomain(): string {
	if (typeof process.getuid !== "function") {
		throw new Error("launchd requires a user session");
	}
	return `gui/${process.getuid()}`;
}

async function installMacService(input: InstallServiceInput): Promise<void> {
	const wrapperPath = await writePosixWrapper(input.command);
	const plistPath = join(
		homedir(),
		"Library",
		"LaunchAgents",
		`${MAC_LABEL}.plist`
	);
	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${wrapperPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${homedir()}</string>
</dict>
</plist>
`;
	await mkdir(dirname(plistPath), { recursive: true });
	await writeFile(plistPath, plist, "utf8");
	await runCommand("launchctl", ["bootout", getMacDomain(), plistPath]).catch(
		() => undefined
	);
	await runCommand("launchctl", ["bootstrap", getMacDomain(), plistPath]);
	await runCommand("launchctl", [
		"kickstart",
		"-k",
		`${getMacDomain()}/${MAC_LABEL}`,
	]);
}

async function uninstallMacService(): Promise<void> {
	const plistPath = join(
		homedir(),
		"Library",
		"LaunchAgents",
		`${MAC_LABEL}.plist`
	);
	await runCommand("launchctl", ["bootout", getMacDomain(), plistPath]).catch(
		() => undefined
	);
	await rm(plistPath, { force: true });
}

async function installWindowsService(
	input: InstallServiceInput
): Promise<void> {
	const wrapperPath = await writeWindowsWrapper(input.command);
	await runCommand("schtasks", [
		"/Create",
		"/SC",
		"ONLOGON",
		"/TN",
		WINDOWS_TASK_NAME,
		"/TR",
		`cmd.exe /c ${quoteWindows(wrapperPath)}`,
		"/F",
	]);
	await runCommand("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME]).catch(
		() => undefined
	);
}

async function uninstallWindowsService(): Promise<void> {
	await runCommand("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME]).catch(
		() => undefined
	);
	await runCommand("schtasks", [
		"/Delete",
		"/TN",
		WINDOWS_TASK_NAME,
		"/F",
	]).catch(() => undefined);
}

export async function installAndStartBackgroundService(
	input: InstallServiceInput
): Promise<void> {
	await mkdir(dirname(resolve(input.logPath)), { recursive: true });
	switch (process.platform) {
		case "linux":
			await installLinuxService(input);
			return;
		case "darwin":
			await installMacService(input);
			return;
		case "win32":
			await installWindowsService(input);
			return;
		default:
			throw new Error(`Unsupported platform: ${process.platform}`);
	}
}

export async function stopAndRemoveBackgroundService(): Promise<void> {
	switch (process.platform) {
		case "linux":
			await uninstallLinuxService();
			return;
		case "darwin":
			await uninstallMacService();
			return;
		case "win32":
			await uninstallWindowsService();
			return;
		default:
			throw new Error(`Unsupported platform: ${process.platform}`);
	}
}

export function getBackgroundServicePackagingNote(): string {
	const entrypoint = process.argv[1] ?? "";
	if (existsSync(entrypoint) && !entrypoint.endsWith(".ts")) {
		return "";
	}
	return "Packaging note: the background service currently targets the active Bun script path for development. Production packaging needs a stable installed bin or bundled entrypoint for the service manager to execute.";
}
