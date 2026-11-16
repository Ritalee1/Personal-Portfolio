import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" so the built index.html loads its assets from the file system inside Electron.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5173, strictPort: true },
});
