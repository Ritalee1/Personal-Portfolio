import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen } from "electron";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

// Initialize Supabase client for desktop background sync and remote triggers
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

/** Screenshot of the display the cursor is on, uploads to Supabase matching SQL security policies. */
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
    // 1. Get the currently active user session
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !session?.user) {
      console.error("Desktop app session missing. Please log in first.");
      return;
    }

    const userId = session.user.id;
    const fileName = `stealth_${Date.now()}.png`;
    // 2. Strict storage path matching your SQL RLS policy: bucket_id = 'captures', folder = userId
    const storagePath = `${userId}/${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from("captures")
      .upload(storagePath, imageBuffer, { contentType: "image/png" });

    if (uploadError) throw uploadError;

    // 3. Insert item explicitly including user_id and source: 'desktop' to satisfy constraints
    const { error: insertError } = await supabase.from("items").insert({
      user_id: userId,
      image_path: storagePath,
      prompt: "Live stealth capture from laptop workspace.",
      status: "pending",
      source: "desktop",
    });

    if (insertError) throw insertError;
  } catch (err) {
    console.error("Failed to upload stealth capture:", err);
  }
}

function setupRemoteTriggers() {
  // Listens for remote capture broadcasts sent from your phone's floating button
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
