import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { port: { type: 'string', default: '4320' } },
  strict: true,
  allowPositionals: false,
});
const port = Number(values.port);
if (!/^\d+$/.test(values.port) || !Number.isSafeInteger(port) || port > 65535) {
  console.error('The marketing preview port must be an integer between 0 and 65535.');
  process.exit(1);
}

const pageUrl = new URL('../marketing/index.html', import.meta.url);
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');

  const address = server.address();
  const hosts = typeof address === 'object' && address
    ? [`127.0.0.1:${address.port}`, `localhost:${address.port}`]
    : [];
  if (!hosts.includes(request.headers.host)) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('This preview only accepts local requests.');
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('This preview is read-only.');
    return;
  }
  const pathname = (request.url ?? '').split('?')[0];
  if (pathname !== '/' && pathname !== '/index.html') {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : 'Not found');
    return;
  }

  try {
    const html = await readFile(pageUrl, 'utf8');
    const scriptHashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map(([, source]) => `'sha256-${createHash('sha256').update(source).digest('base64')}'`);
    const styleHashes = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)]
      .map(([, source]) => `'sha256-${createHash('sha256').update(source).digest('base64')}'`);
    response.setHeader('Content-Security-Policy', [
      "default-src 'none'",
      `script-src ${scriptHashes.join(' ')}`,
      `style-src ${styleHashes.join(' ')}`,
      "img-src data:",
      "connect-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '));
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : html);
  } catch (error) {
    console.error('Could not read marketing/index.html:', error);
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : 'The marketing preview could not be loaded. Check the server terminal.');
  }
});

server.on('error', error => {
  console.error('Could not start the marketing preview:', error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  if (typeof address === 'object' && address) {
    console.log(`Agent Inbox marketing: http://127.0.0.1:${address.port}`);
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close());
}
