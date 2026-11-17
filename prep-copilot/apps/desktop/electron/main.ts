import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen } from "electron";
import path from "node:path";

const CAPTURE_SHORTCUT = "CommandOrControl+Shift+S";
const TOGGLE_SHORTCUT = "CommandOrControl+Shift+H"; // Manually hide/show the window
let win: BrowserWindow | null = null;

// Must run BEFORE app is ready, or the switches are ignored.
// The window runs hidden and never paints to screen, so the GPU/disk cache
// buys us nothing — disabling it silences the Windows "cache: Access is denied"
// and "Gpu Cache Creation failed" noise (common when running from a
// OneDrive-synced folder like Desktop).
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("disable-gpu-disk-cache");

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "Prep Copilot",
    show: true, // Visible on launch; hide manually with Ctrl/Cmd+Shift+H
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep realtime/timers alive while hidden
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

/**
 * Grab a PNG of the display the cursor is on and return it as base64.
 * Uploading is done in the renderer, which holds the logged-in Supabase
 * session — the main process is never authenticated.
 */
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

  // Global Hotkey: manually toggle the window between hidden and visible
  globalShortcut.register(TOGGLE_SHORTCUT, () => {
    if (!win) return createWindow();
    if (win.isVisible()) win.hide();
    else {
      win.show();
      win.focus();
    }
  });

  // Global Hotkey: capture the screen and hand it to the (authenticated) renderer
  globalShortcut.register(CAPTURE_SHORTCUT, async () => {
    try {
      const png = await captureScreen();
      win?.webContents.send("captured", png);
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
