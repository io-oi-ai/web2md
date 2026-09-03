import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/native-host.ts', 'src/install.ts', 'src/setup.ts'],
  format: ['cjs'],
  outDir: 'dist',
  splitting: false,
  clean: true,
})
