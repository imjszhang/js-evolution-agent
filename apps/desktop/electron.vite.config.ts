import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { isDesktopMainExternal } from './src/main/bundle-externals'

const desktopDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(desktopDir, 'src/main/index.ts'),
        external: isDesktopMainExternal
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(desktopDir, 'src/preload/index.ts'),
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve(desktopDir, 'src/renderer'),
    plugins: [react()]
  }
})
