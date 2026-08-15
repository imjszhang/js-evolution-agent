import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

const desktopDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(desktopDir, 'src/main/index.ts')
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(desktopDir, 'src/preload/index.ts')
      }
    }
  },
  renderer: {
    root: resolve(desktopDir, 'src/renderer'),
    plugins: [react()]
  }
})
