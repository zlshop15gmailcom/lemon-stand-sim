import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves this as a project site at /lemon-stand-sim/, not the
  // domain root, so all asset URLs need that prefix baked in at build time.
  base: '/lemon-stand-sim/',
})
