import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  publicDir: false,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    target: "es2018",
    outDir: "wechat-minigame/dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: false,
    reportCompressedSize: false,
    lib: {
      entry: `${projectRoot}src/wechat/main.js`,
      name: "BoltboundMiniGame",
      formats: ["iife"],
      fileName: () => "game.bundle.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
