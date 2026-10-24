import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

const rawPort = process.env.PORT;
// PORT нужен только для dev-сервера; при production build может отсутствовать
const port = rawPort ? Number(rawPort) : 3000;

// BASE_PATH нужен для корректного роутинга; при production build (CI) можно без него
const basePath = process.env.BASE_PATH ?? "/";
const appVersion = (
  process.env.REPLIT_DEPLOYMENT_ID ??
  process.env.GIT_COMMIT_SHA ??
  process.env.REPL_ID ??
  "development"
)
  .replace(/[^a-zA-Z0-9._-]/g, "_")
  .slice(0, 80);

export default defineConfig({
  base: basePath,
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    {
      name: "inject-app-version",
      transformIndexHtml(html) {
        return html.replaceAll("__ALT_APP_VERSION__", appVersion);
      },
    },
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(
        import.meta.dirname,
        "..",
        "..",
        "attached_assets",
      ),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.API_SERVER_PORT || "8080"}`,
        changeOrigin: true,
      },
    },
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
