import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// Минимальный статический файл-сервер только на встроенных node:http/node:fs —
// в проекте такого не было (Stage 11B preflight запускал `python3 -m
// http.server` вручную), а сторонний пакет (serve/http-server и т.п.) explicitly
// запрещён заданием. Не содержит НИКАКОЙ YAAM-специфичной логики (никаких
// упоминаний API base URL и т.п.) — это обобщённый static file server,
// который просто отдаёт client/ как есть; вся YAAM-специфичная связка с
// локальным backend'ом живёт в fixtures/test-api-hook.ts и ставится через
// page.addInitScript(), не здесь.

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
  // Манифест PWA. Без явного типа он уезжал бы в fallback
  // application/octet-stream, и e2e-прогон отличался бы от продакшена
  // (GitHub Pages отдаёт .webmanifest как application/manifest+json).
  '.webmanifest': 'application/manifest+json',
};

export interface StaticServerHandle {
  server: http.Server;
  close(): Promise<void>;
}

// Обобщённое преобразование текстового файла перед отдачей. Сам сервер
// по-прежнему ничего не знает про YAAM: что и на что менять, решает вызывающий
// (см. e2e/fixtures/test-api-hook.ts). Раньше связка с локальным backend'ом
// делалась через page.addInitScript(), выставлявший window-глобалы, которые
// ради этого приходилось читать в client/js/api.js — то есть тестовый
// переключатель endpoint'а жил в публичном бандле. Подстановка при отдаче
// файла оставляет его целиком в тестовой обвязке и, в отличие от перехвата
// запросов, корректно работает с service worker'ом: в кэш попадает уже
// преобразованный файл.
export type FileTransform = (relativePath: string, source: string) => string | null;

const TRANSFORMABLE = new Set(['.js', '.html', '.css', '.json', '.webmanifest', '.svg']);

export function startStaticServer(
  { rootDir, port, transform }: { rootDir: string; port: number; transform?: FileTransform },
): Promise<StaticServerHandle> {
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
      const contentType = MIME[ext] || 'application/octet-stream';

      // Преобразование применяется только к текстовым типам и только если
      // callback реально что-то вернул: бинарные ассеты (png/jpg/webp) нельзя
      // прогонять через utf8, а файлы, до которых преобразованию нет дела,
      // должны отдаваться потоком, как и раньше.
      if (transform && TRANSFORMABLE.has(ext)) {
        const relativePath = path.relative(resolvedRoot, filePath).split(path.sep).join('/');
        const transformed = transform(relativePath, fs.readFileSync(filePath, 'utf8'));
        if (transformed !== null && transformed !== undefined) {
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': Buffer.byteLength(transformed),
          });
          res.end(transformed);
          return;
        }
      }

      res.writeHead(200, { 'Content-Type': contentType });
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
