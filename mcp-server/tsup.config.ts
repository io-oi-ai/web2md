import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/native-host.ts', 'src/install.ts', 'src/setup.ts', 'src/oauth.ts'],
  format: ['cjs'],
  outDir: 'dist',
  splitting: false,
  clean: true,
  external: ["@firecrawl/anydoc"],  // napi 原生绑定,不能打进 bundle
  // 开源版把 shared 内联成 ./vendor/*,无需 noExternal
})
