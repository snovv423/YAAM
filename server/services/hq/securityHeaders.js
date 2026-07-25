'use strict';

// Заголовки безопасности для всех /hq/** ответов. Не подключаем `helmet`
// ради 5 статических заголовков — это единственная новая зависимость,
// которую действительно стоило добавить (express-session), остальное здесь
// не криптография и не подвержено тонким ошибкам, которые оправдывали бы
// библиотеку вместо десятка строк res.set().
//
// HQ не встраивает и не грузит ничего стороннего (ни один внешний скрипт,
// шрифт, iframe) — поэтому CSP может быть максимально строгим (self-only),
// без исключений "на всякий случай".
function hqSecurityHeaders(req, res, next) {
  res.set('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // инлайновый <style> в layout — тот же приём, что и admin/layout.js
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'", // современная замена X-Frame-Options, тот же смысл
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '));
  res.set('X-Frame-Options', 'DENY');
  res.set('X-Content-Type-Options', 'nosniff');
  // 'same-origin', не 'no-referrer': HQ никогда не отдаёт referrer стороннему
  // origin (данные не утекают ни в каком случае), но 'no-referrer' имеет
  // задокументированный побочный эффект в браузерах — Origin-заголовок
  // top-level POST-навигации (обычная HTML-форма логина/логаута) при
  // policy=no-referrer отправляется как буквальная строка "null", которую
  // общий CORS-мидлварь приложения (server/config/cors.js) закономерно
  // отклоняет как непонятный origin — сама форма логина переставала
  // проходить собственную CORS-проверку. 'same-origin' не имеет этого
  // эффекта и по смыслу так же не раскрывает ничего постороннему origin.
  res.set('Referrer-Policy', 'same-origin');
  // HQ содержит и агрегированные бизнес-данные (обороты, статусы заказов) —
  // ни один HQ-ответ не должен оседать в browser/proxy-кэше.
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
}

module.exports = { hqSecurityHeaders };
