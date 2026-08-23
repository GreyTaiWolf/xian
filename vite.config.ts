import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    watch: {
      // 忽略编辑工具产生的原子替换临时文件（否则 Windows 下监听器会 EBUSY 崩溃）与参考仓库
      ignored: ['**/.*.tmpdir/**', '**/*.tmp', '**/reference/**'],
    },
    proxy: {
      // M2 接入天道 AI 时使用：前端请求 /api/... → 转发到 DeepSeek（开发期解决 CORS）
      '/api': {
        target: 'https://api.deepseek.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
