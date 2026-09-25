import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      'react/jsx-runtime': path.resolve(__dirname, 'src/types/react.ts'),
      'react': path.resolve(__dirname, 'src/types/react.ts'),
    },
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
    keepNames: true,
  },
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/main.ts'),
      formats: ['iife'],
      name: 'SubwayMod',
      fileName: () => 'index.js',
    },
    outDir: 'dist',
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: 'index.js',
      },
    },
  },
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: 'manifest.json',
          dest: '.',
        },
        // The city's data files are not bundled: the game v1.7.1 reads them from its own cities\data\TYOTL folder,
        // which ../../scripts/install-subway-builder-city.mjs fills (see that script and src/main.ts).
      ],
    }),
  ],
});
