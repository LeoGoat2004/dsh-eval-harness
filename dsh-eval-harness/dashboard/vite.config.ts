import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// The dashboard is a single self-contained HTML file so it opens offline from
// the filesystem and can be shared as one artifact. The run data is injected by
// the generator as `window.__DASHBOARD_DATA__` before the bundle.
export default defineConfig({
  base: './',
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
  },
})
