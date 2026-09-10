import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        game: fileURLToPath(new URL("./index.html", import.meta.url)),
        lab: fileURLToPath(new URL("./lab.html", import.meta.url)),
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
      "/socket.io": {
        target: "http://127.0.0.1:3001",
        ws: true,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
  },
});
