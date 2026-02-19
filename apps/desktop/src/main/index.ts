import path from "node:path";
import { app, BrowserWindow, shell } from "electron";

function createWindow() {
	const win = new BrowserWindow({
		width: 1200,
		height: 800,
		show: false,
		webPreferences: {
			preload: path.join(__dirname, "../preload/index.cjs"),
		},
	});

	win.maximize();
	win.show();

	win.webContents.setWindowOpenHandler(({ url }) => {
		shell.openExternal(url);
		return { action: "deny" };
	});

	if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
		win.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		win.loadFile(path.join(__dirname, "../renderer/index.html"));
	}
}

app.whenReady().then(() => {
	createWindow();
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0) {
		createWindow();
	}
});
