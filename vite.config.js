import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron'

export default defineConfig({
  plugins: [
    vue(),
    electron({
      // نقطة انطلاق الـ Back-end (Main Process)
      entry: 'src/main/main.js',
    }),
  ],
  build: {
    rollupOptions: {
      external: ['ws', 'bufferutil', 'utf-8-validate']
    }
  },
  server: {
    port: 3000
  }
})