import { defineConfig } from 'vite';

/** Bundles the playthrough simulator (tools/playthroughs/run.ts) into dist-sim/playthroughs.js for Node. */
export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'tools/playthroughs/run.ts',
    outDir: 'dist-sim',
    emptyOutDir: true,
    target: 'node20',
    rollupOptions: { output: { entryFileNames: 'playthroughs.js', format: 'es' } },
  },
});
