import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen } from "electron";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

// Initialize Supabase client for stealth sync and remote triggers
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || "https://xblvpcmzvnsmzlfnprlg.supabase.co";
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_V5DRJu_ROxMPDDXYyBYb9g_5a_HpKzc";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CAPTURE_SHORTCUT = "CommandOrControl+Shift+S";
let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "Prep Copilot",
    show: false, // Stealth mode: runs silently in the background
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

/** Screenshot of the display the cursor is on, uploads to Supabase for mobile viewing. */
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

  const imageBuffer = source.thumbnail.toPNG();
  await uploadCaptureToSupabase(imageBuffer);

  return imageBuffer.toString("base64");
}

async function uploadCaptureToSupabase(imageBuffer: Buffer) {
  try {
    const fileName = `stealth_${Date.now()}.png`;
    const { error: uploadError } = await supabase.storage
      .from("captures")
      .upload(fileName, imageBuffer, { contentType: "image/png" });

    if (uploadError) throw uploadError;

    await supabase.from("items").insert({
      image_path: fileName,
      prompt: "Live stealth capture from laptop workspace.",
      status: "pending",
    });
  } catch (err) {
    console.error("Failed to upload stealth capture:", err);
  }
}

function setupRemoteTriggers() {
  supabase
    .channel("desktop-commands")
    .on("broadcast", { event: "trigger_capture" }, async () => {
      try {
        await captureScreen();
      } catch (e) {
        console.error("Remote capture failed:", e);
      }
    })
    .subscribe();
}

ipcMain.handle("capture-screen", () => captureScreen());

app.whenReady().then(() => {
  createWindow();
  setupRemoteTriggers();

  // Global Hotkey: capture screen silently in the background
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
