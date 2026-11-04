/** Local-only harness for the actual production build. Never copied into viewer/dist. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { maliciousShare, designShare, benchmarkShare } from '../tests/fixtures';
import { lockContent } from '../shared/encryption';
import { MAX_SHARE_BYTES } from '../shared/format';

const dist = resolve('viewer/dist'), local = resolve('.local');
const port = Number(process.env.PORT || 4173);

const headerText = await readFile(resolve(dist, '_headers'), 'utf8');
const headers = Object.fromEntries(headerText.split('\n').filter(line => /^  [\w-]+:/.test(line)).map(line => {
  const colon = line.indexOf(':'); return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
}));
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json' };
const gid = '00000000000000000000000000000001';
const raw = `https://gist.githubusercontent.com/local-preview/${gid}/raw/chat-share.json`;
const allowed = new Set(['design', 'locked', 'malicious', 'claude', 'codex', 'invalid', 'oversized', 'deleted', 'failure', 'benchmark']);
// Encrypted once, like a Gist: its content does not change between page loads.
let lockedPreview: string | undefined;
const server = createServer(async (request, response) => {
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.setHeader('Cache-Control', 'no-store');
  const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === '/__preview/image.svg') {
      response.setHeader('Content-Type', 'image/svg+xml');
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="100"><rect width="480" height="100" rx="8" fill="#eeeeee"/><path d="M40 52h60m20 0h60m20 0h60m20 0h60" stroke="#555" stroke-width="2"/><circle cx="380" cy="52" r="10" fill="#247b50"/></svg>'); return;
    }
    if (url.pathname === '/__preview/bootstrap.js') {
      const name = url.searchParams.get('file') || '';
      if (!allowed.has(name)) { response.writeHead(404); response.end(); return; }
      let payload: string, status = 200, declared: number | undefined;
      if (name === 'design') payload = JSON.stringify(designShare());
      else if (name === 'locked') payload = lockedPreview ??= await lockContent(JSON.stringify(designShare()), '482913');
      else if (name === 'malicious') payload = JSON.stringify(maliciousShare());
      else if (name === 'benchmark') payload = JSON.stringify(benchmarkShare());
      else if (name === 'invalid') payload = '{"version":9000}';
      else if (name === 'deleted') { payload = ''; status = 404; }
      else if (name === 'failure') { payload = ''; status = 503; }
      else if (name === 'oversized') { payload = ''; declared = MAX_SHARE_BYTES + 1; }
      else {
        try {
          payload = await readFile(resolve(local, `${name}.json`), 'utf8');
        } catch {
          response.writeHead(404);
          response.end(`Local session ${name}.json not found`);
          return;
        }
      }
      const literal = JSON.stringify(payload).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
      response.setHeader('Content-Type', mime['.js']!);
      response.end(`const originalFetch=window.fetch.bind(window);const payload=${literal};window.__previewChecks={csp:[],errors:0};document.addEventListener('securitypolicyviolation',e=>window.__previewChecks.csp.push(e.violatedDirective));window.addEventListener('error',()=>window.__previewChecks.errors++);window.fetch=(input,init)=>String(input)===${JSON.stringify(raw)}?Promise.resolve(new Response(payload,{status:${status},headers:{'content-type':'text/plain',${declared ? `'content-length':'${declared}'` : ''}}})):originalFetch(input,init);`);
      return;
    }
    const name = url.searchParams.get('preview');
    if (url.pathname === '/' && name && allowed.has(name)) {
      let html = await readFile(resolve(dist, 'index.html'), 'utf8');
      html = html.replace('<head>', `<head><script src="/__preview/bootstrap.js?file=${name}"></script>`);
      response.setHeader('Content-Type', mime['.html']!); response.end(html); return;
    }
    const path = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    if (path !== dist && !path.startsWith(dist + sep)) { response.writeHead(404); response.end(); return; }
    const file = (await stat(path)).isDirectory() ? resolve(path, 'index.html') : path;
    response.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch {
    // Do not include a local export path or any session content in HTTP errors/logs.
    response.writeHead(404); response.end('Not found');
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Production preview with _headers: http://127.0.0.1:${port}/`);
  for (const name of ['malicious', 'claude', 'codex']) console.log(`http://127.0.0.1:${port}/?preview=${name}#local-preview/${gid}`);
});
