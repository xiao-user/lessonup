import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          if (id.includes("commonjsHelpers")) return "vendor-react";
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/node_modules/@tiptap/") || /\/node_modules\/prosemirror-[^/]+\//.test(id)) return "vendor-editor";
          if (id.includes("/gsap/") || id.includes("/@gsap/")) return "vendor-gsap";
          if (id.includes("/node_modules/react/") || id.includes("/node_modules/react-dom/") || id.includes("/node_modules/scheduler/")) {
            return "vendor-react";
          }
          return undefined;
        },
      },
    },
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom/client",
      "react-markdown",
      "remark-gfm",
    ],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
    proxy: {
      "/api": process.env.LESSONUP_API_ORIGIN ?? "http://127.0.0.1:8787",
      "/mcp": process.env.LESSONUP_API_ORIGIN ?? "http://127.0.0.1:8787",
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [react(), tailwindcss()],
});
