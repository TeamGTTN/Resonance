import { cpSync } from 'node:fs';

try {
  cpSync('manifest.json', 'dist/manifest.json', { recursive: false });
  cpSync('styles.css', 'dist/styles.css', { recursive: false });
  console.log('Postbuild: copied manifest.json and styles.css into dist/.');
} catch (e) {
  console.error('Postbuild error:', e);
  process.exitCode = 1;
}
