import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  server: {
    host: "0.0.0.0",
    fs: { allow: [".."] }
  },
  build: {
    outDir: "../dist-web",
    emptyOutDir: true
  }
});
