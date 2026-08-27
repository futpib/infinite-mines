import { defineConfig } from "vite";

const lanHosts = ["claude-laptop.lan"];

export default defineConfig({
  base: "./",
  server: {
    allowedHosts: lanHosts,
  },
  preview: {
    allowedHosts: lanHosts,
  },
});
