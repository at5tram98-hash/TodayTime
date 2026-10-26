// Regenerates the precache manifest in sw.js from the app files and stamps a content hash,
// so every change to the app produces a new service worker (and a clean cache).
// Usage: node tools/stamp-sw.mjs
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const walk = (dir) => readdirSync(join(root, dir)).flatMap((f) => {
  const p = join(dir, f);
  return statSync(join(root, p)).isDirectory() ? walk(p) : [p];
});
const files = ['index.html', 'manifest.json', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', ...walk('src').filter((f) => /\.(js|mjs|css)$/.test(f))].sort();
const hash = createHash('sha256');
for (const f of files) hash.update(f).update(readFileSync(join(root, f)));
const version = hash.digest('hex').slice(0, 12);

const swPath = join(root, 'sw.js');
let sw = readFileSync(swPath, 'utf8');
sw = sw.replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`);
sw = sw.replace(/const PRECACHE = \[[\s\S]*?\];/, `const PRECACHE = [\n${['./', ...files].map((f) => `  '${f.replace(/^\.\//, './')}',`).join('\n')}\n];`);
writeFileSync(swPath, sw);
console.log(`sw.js stamped ${version} (${files.length} files)`);
