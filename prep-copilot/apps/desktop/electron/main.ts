import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen } from "electron";
import path from "node:path";

const CAPTURE_SHORTCUT = "CommandOrControl+Shift+S";
let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "Prep Copilot",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

/** Screenshot of the display the cursor is on, as a base64 PNG. */
async function captureScreen(): Promise<string> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { width, height } = display.size;
  const scale = display.scaleFactor;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
  });
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
  if (!source) throw new Error("No screen available to capture");
  return source.thumbnail.toPNG().toString("base64");
}

ipcMain.handle("capture-screen", () => captureScreen());

app.whenReady().then(() => {
  createWindow();

  // Hotkey: capture the screen and hand it to the app window for explanation.
  globalShortcut.register(CAPTURE_SHORTCUT, async () => {
    try {
      const png = await captureScreen();
      win?.webContents.send("captured", png);
      win?.show();
    } catch (e) {
      win?.webContents.send("capture-error", String(e));
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
