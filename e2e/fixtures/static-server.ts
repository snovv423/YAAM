import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// Минимальный статический файл-сервер только на встроенных node:http/node:fs —
// в проекте такого не было (Stage 11B preflight запускал `python3 -m
// http.server` вручную), а сторонний пакет (serve/http-server и т.п.) explicitly
// запрещён заданием. Не содержит НИКАКОЙ YAAM-специфичной логики (никаких
// упоминаний API base URL и т.п.) — это обобщённый static file server,
// который просто отдаёт client/ как есть; вся YAAM-специфичная связка через
// window.YAAM_API_BASE_URL делается в тесте через page.addInitScript(),
// не здесь.

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

export interface StaticServerHandle {
  server: http.Server;
  close(): Promise<void>;
}

export function startStaticServer({ rootDir, port }: { rootDir: string; port: number }): Promise<StaticServerHandle> {
  const resolvedRoot = path.resolve(rootDir);

  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      let filePath = path.join(resolvedRoot, urlPath === '/' ? 'index.html' : urlPath);

      // Защита от выхода за пределы rootDir через "../" в URL — обязательна
      // для любого сервера, отдающего произвольные пути напрямую из запроса,
      // даже локального dev-инструмента.
      if (!filePath.startsWith(resolvedRoot)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        // client/ — один-единственный index.html (без клиентского роутера
        // на history API кроме уже существующего pushState в самом app.js),
        // поэтому неизвестный путь безопасно откатывается на index.html.
        filePath = path.join(resolvedRoot, 'index.html');
      }

      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      res.writeHead(500);
      res.end('Internal static server error');
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
