// Static server that mirrors GitHub Pages: the repository is served under /TodayTime/.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ics': 'text/calendar' };

export function serve(port = 4173) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__moodle.ics') {
      // Fake Moodle endpoint for e2e tests. ?cors=1 adds CORS headers.
      if (url.searchParams.get('cors')) res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'text/calendar');
      res.end((await readFile(join(root, 'tests/e2e/moodle-sample.ics'), 'utf8')).replaceAll('{{SHIFT}}', url.searchParams.get('shift') || '0'));
      return;
    }
    if (!url.pathname.startsWith('/TodayTime/')) { res.writeHead(302, { Location: '/TodayTime/' }); res.end(); return; }
    let p = normalize(decodeURIComponent(url.pathname.slice('/TodayTime/'.length)));
    if (p.startsWith('..')) { res.writeHead(403); res.end(); return; }
    let file = join(root, p);
    try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); } catch { res.writeHead(404); res.end('not found'); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = +process.argv[2] || 4173;
  serve(port).then(() => console.log(`http://localhost:${port}/TodayTime/`));
}
