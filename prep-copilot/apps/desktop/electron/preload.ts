import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("copilot", {
  captureScreen: (): Promise<string> => ipcRenderer.invoke("capture-screen"),
  onCaptured: (cb: (pngBase64: string) => void) => {
    const listener = (_: unknown, png: string) => cb(png);
    ipcRenderer.on("captured", listener);
    return () => ipcRenderer.removeListener("captured", listener);
  },
  onCaptureError: (cb: (message: string) => void) => {
    const listener = (_: unknown, msg: string) => cb(msg);
    ipcRenderer.on("capture-error", listener);
    return () => ipcRenderer.removeListener("capture-error", listener);
  },
});
