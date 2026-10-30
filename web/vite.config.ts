import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createServer, defineConfig, loadEnv, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { render } from 'svelte/server';

const require = createRequire(import.meta.url);
const faceApiDir = dirname(require.resolve('@vladmandic/face-api/package.json'));
const faceApiVersion: string = JSON.parse(readFileSync(join(faceApiDir, 'package.json'), 'utf8')).version;
// Detector, landmarks (to line faces up) and recognition: about 12 MB, only downloaded when a guest uses Find me.
const FACE_MODELS = ['ssd_mobilenetv1_model', 'face_landmark_68_model', 'face_recognition_model'].flatMap((m) => [
  `${m}-weights_manifest.json`,
  `${m}.bin`,
]);
// Under assets/ with the version in the path, so the service worker can keep them like any other built asset.
const FACE_MODEL_DIR = `assets/face-models-${faceApiVersion}/`;

/** Serves the face models from node_modules in dev and copies them into the build, so they come from SnapWall's own origin. */
function faceModels(base: string): Plugin {
  return {
    name: 'snapwall-face-models',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = req.url?.split('?')[0].replace(base + FACE_MODEL_DIR, '');
        if (!file || !FACE_MODELS.includes(file)) return next();
        res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
        res.end(readFileSync(join(faceApiDir, 'model', file)));
      });
    },
    generateBundle() {
      for (const file of FACE_MODELS) {
        this.emitFile({ type: 'asset', fileName: FACE_MODEL_DIR + file, source: readFileSync(join(faceApiDir, 'model', file)) });
      }
    },
  };
}

/**
 * Writes the privacy page as plain HTML at privacy.html, from the same component the app shows at #/privacy. Google's
 * app review wants a privacy policy URL it can read without running the app, and some reviewers reject # in it.
 */
function staticPrivacy(): Plugin {
  return {
    name: 'snapwall-static-privacy',
    apply: 'build',
    async generateBundle(_, bundle) {
      const entry = Object.values(bundle).find((c) => c.type === 'chunk' && c.isEntry);
      const css = entry?.type === 'chunk' ? [...(entry.viteMetadata?.importedCss ?? [])] : [];
      // A throwaway server compiles the component for rendering on Node, with the same Svelte setup as the app.
      const server = await createServer({ configFile: false, plugins: [svelte()], server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
      try {
        const { default: Privacy } = await server.ssrLoadModule('/src/routes/Privacy.svelte');
        const { body } = render(Privacy);
        const source = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="referrer" content="no-referrer" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'" />
    <meta name="description" content="How SnapWall handles your data: what it stores, what it never stores, and how to remove it." />
    <meta name="theme-color" content="#faf9f7" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#0e0e0d" media="(prefers-color-scheme: dark)" />
    <link rel="icon" href="favicon.svg" type="image/svg+xml" />
${css.map((f) => `    <link rel="stylesheet" href="${f}" />`).join('\n')}
    <title>Privacy · SnapWall</title>
  </head>
  <body>
    <div id="app">${body}</div>
  </body>
</html>
`;
        this.emitFile({ type: 'asset', fileName: 'privacy.html', source });
      } finally {
        await server.close();
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const api = env.VITE_API_URL || 'http://localhost:8787';
  // GitHub Pages serves project sites from /<repo>/
  const base = env.VITE_BASE || '/snapwall/';
  return {
    base,
    plugins: [
      svelte(),
      {
        name: 'snapwall-csp',
        transformIndexHtml: (html) => html.replaceAll('__API_ORIGIN__', new URL(api).origin),
      },
      faceModels(base),
      staticPrivacy(),
    ],
    define: { __API_URL__: JSON.stringify(api.replace(/\/$/, '')), __FACE_MODELS__: JSON.stringify(base + FACE_MODEL_DIR) },
    // The face library (with TensorFlow.js) is one large chunk, loaded only when a guest uses Find me.
    build: { chunkSizeWarningLimit: 1500 },
  };
});
