import { defineConfig } from 'vite'

// Set BASE_PATH=/your-repo-name/ when deploying to GitHub Project Pages.
const base = process.env.BASE_PATH ?? './'

export default defineConfig({
  base,
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
})
