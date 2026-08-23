import { defineConfig } from 'vite';

/** 动态世界内核自测：打包为可在 Node 环境执行的 ES 模块。 */
export default defineConfig({
  build: {
    outDir: 'dist-worldsim',
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: 'scripts/worldsim-selftest.ts',
      formats: ['es'],
      fileName: () => 'worldsim-selftest.mjs',
    },
  },
});
