import { cpSync } from 'node:fs';

try {
  cpSync('manifest.json', 'dist/manifest.json', { recursive: false });
  cpSync('styles.css', 'dist/styles.css', { recursive: false });
  console.log('Postbuild: copiati manifest.json e styles.css in dist/.');
} catch (e) {
  console.error('Postbuild error:', e);
  process.exitCode = 1;
}
