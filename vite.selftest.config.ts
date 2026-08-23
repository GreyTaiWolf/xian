import { defineConfig } from 'vite';

/** 自测专用构建：把 scripts/selftest.ts 打包为可在 Node 运行的 ES 模块。 */
export default defineConfig({
  build: {
    outDir: 'dist-test',
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: 'scripts/selftest.ts',
      formats: ['es'],
      fileName: () => 'selftest.mjs',
    },
  },
});
