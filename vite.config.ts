import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./src/desktop/renderer", import.meta.url)),
  base: "./",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("./.build/desktop-renderer", import.meta.url)),
    emptyOutDir: false,
    sourcemap: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react",
              test: /node_modules[\\/](?:react(?:-dom)?|scheduler)[\\/]/,
              priority: 30,
            },
            {
              name: "markdown",
              test: /node_modules[\\/](?:react-markdown|remark[^\\/]*|rehype[^\\/]*|unified|micromark[^\\/]*|mdast-util[^\\/]*|hast-util[^\\/]*|unist-util[^\\/]*|vfile[^\\/]*)[\\/]/,
              priority: 20,
            },
            {
              name: "vendor",
              test: /node_modules[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
