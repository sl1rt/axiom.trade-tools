import { build } from 'vite';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const entry of ['background', 'content', 'quote-reader']) {
  await build({
    configFile: false,
    root,
    build: {
      outDir: 'dist',
      emptyOutDir: entry === 'background',
      minify: false,
      lib: {
        entry: `src/${entry}.ts`,
        formats: [entry === 'background' ? 'es' : 'iife'],
        name: 'AxiomEarlyWallets',
        fileName: () => `${entry}.js`,
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
}
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await copyFile(
  new URL('../manifest.json', import.meta.url),
  new URL('../dist/manifest.json', import.meta.url),
);
