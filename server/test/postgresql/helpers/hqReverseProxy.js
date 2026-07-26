'use strict';

// YAAM HQ Stage 2.1 — тестовый харнесс, воспроизводящий ТОЧНОЕ поведение
// реального production Nginx-блока для hq.yaam.su (см. финальный отчёт
// Stage 2.1, раздел 9):
//
//   location / {
//       proxy_pass http://127.0.0.1:<port>/hq/;
//   }
//
// Ключевая деталь, которую легко перепутать (и именно поэтому задание прямо
// требует ПРОВЕРИТЬ, а не написать конфиг по памяти): при указанном в
// proxy_pass URI ("/hq/") nginx заменяет СОВПАВШУЮ часть location ("/", 1
// символ) на этот URI и ДОБАВЛЯЕТ остаток исходного пути. Для location "/"
// совпадение — всегда ровно один символ ("/"), поэтому итоговый путь на
// backend — "/hq/" + <путь без ведущего слэша>, НЕ "/hq" + <путь как есть>
// (без trailing slash в proxy_pass итог был бы "/hq" + "login" = "/hqlogin"
// — сломанный путь без разделителя). Настоящий nginx в этой сессии/окружении
// недоступен (проверено — бинарник отсутствует) — вместо "написать конфиг по
// памяти и понадеяться" этот же rewrite воспроизведён явно здесь и проверен
// тестами (server/test/postgresql/hqCleanRootStage21.test.js,
// e2e/tests/hq-clean-root-flow.spec.ts — оба require()-ят этот же файл, а не
// две отдельные копии логики).
//
// НЕ переписывает тело ответа и заголовок Location — ровно как обычный
// nginx proxy_pass БЕЗ proxy_redirect/sub_filter (ни то, ни другое не
// используется и в реальном конфиге раздела 9 отчёта). Если бы приложение
// когда-нибудь написало "/hq" в HTML/Location, этот харнесс — как и
// настоящий nginx в этой конфигурации — его бы НЕ скрыл. Это намеренно:
// доказывает, что clean-root работает благодаря linkBasePath на уровне
// приложения (services/hq/basePath.js), а не благодаря "хитрости" прокси.
//
// Используется ТОЛЬКО из тестов — не часть приложения.
const http = require('node:http');

function startHqReverseProxy({ upstreamPort, port, publicHost, forwardedProto }) {
  const server = http.createServer((req, res) => {
    const originalUrl = req.url || '/';
    const remainder = originalUrl.startsWith('/') ? originalUrl.slice(1) : originalUrl;
    const upstreamPath = `/hq/${remainder}`;

    const proxyReq = http.request(
      {
        host: '127.0.0.1',
        port: upstreamPort,
        method: req.method,
        path: upstreamPath,
        headers: {
          ...req.headers,
          host: publicHost,
          'x-forwarded-host': publicHost,
          'x-forwarded-proto': forwardedProto || 'http',
          'x-forwarded-for': '127.0.0.1',
        },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on('error', () => {
      res.writeHead(502);
      res.end('Bad gateway (hq-reverse-proxy test harness)');
    });

    req.pipe(proxyReq);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

module.exports = { startHqReverseProxy };
