import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Em dev, /api é encaminhado ao backend .NET. Em produção o .NET serve o build (wwwroot).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:5080' } },
  build: { outDir: '../backend/GlpiBoard.Api/wwwroot', emptyOutDir: true },
})
