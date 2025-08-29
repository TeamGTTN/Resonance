import { defineConfig } from 'vite';
import { builtinModules } from 'module';

export default defineConfig({
  build: {
    lib: {
      entry: 'main.ts',
      formats: ['cjs'],
      fileName: () => 'main',
      name: 'resonance',
    },
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      external: [
        'obsidian', 'electron', 'path', 'fs', 'os', 'child_process',
        ...builtinModules,
      ],
      output: {
        entryFileNames: 'main.js',
        exports: 'default',
      },
    },
    target: 'es2020',
    minify: false,
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
  },
});
