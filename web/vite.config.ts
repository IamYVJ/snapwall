import { defineConfig, loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const api = env.VITE_API_URL || 'http://localhost:8787';
  return {
    // GitHub Pages serves project sites from /<repo>/
    base: env.VITE_BASE || '/snapwall/',
    plugins: [
      svelte(),
      {
        name: 'snapwall-csp',
        transformIndexHtml: (html) => html.replaceAll('__API_ORIGIN__', new URL(api).origin),
      },
    ],
    define: { __API_URL__: JSON.stringify(api.replace(/\/$/, '')) },
  };
});
