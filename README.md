# YAAM

Локальный агрегатор доставки еды для Чечни. Frontend — статический
HTML/CSS/JS; backend — Node.js/Express с PostgreSQL staging и сохранённым
SQLite compatibility path.

## Структура

```
client/           GitHub Pages frontend; yaam.su сейчас работает в demo-режиме
  index.html      разметка экранов
  css/style.css   вся стилистика (Liquid Glass, тёмно-зелёный + янтарный)
  js/data.js      демо-данные: рестораны, меню, кандидаты на голосование
  js/api.js       мост к бэкенду (если window.YAAM_API_BASE_URL не задан — работает на demo-данных)
  js/app.js       логика: корзина (доставка/самовывоз на выбор), чекаут, QR-оплата, статусы заказа, голосование
  legal/          юридические страницы (оферта, политика ПДн, оплата/возврат, доставка и т.д.)
server/           API, PostgreSQL/SQLite paths, платежи, admin, bot, deploy
docs/             актуальный статус, backlog, ADR/runbooks и audit history
```

## Запуск

Frontend demo:

```
cd client && python3 -m http.server 8080
```

SQLite/local backend:

```
cd server && npm install && npm run seed && npm start
```

Тесты:

```bash
cd server
npm test
npm run test:postgresql
```

## Текущее состояние

- Frontend: `https://yaam.su`, demo, не связан со staging API.
- PostgreSQL staging: `https://api-pg.yaam.su`.
- YooKassa: только тестовый магазин/Sandbox на staging.
- Webhook: `POST /api/webhooks/payment`.
- Production traffic выключен; production onboarding YooKassa не завершён.
- СБП и требования 54-ФЗ ещё не проверены.

## Документация

- [Правила Claude и архитектура](CLAUDE.md)
- [Правила Codex](AGENTS.md)
- [Актуальный статус](docs/PROJECT_STATUS.md)
- [Открытый backlog](docs/PROJECT_BACKLOG.md)
- [PostgreSQL deployment runbook](server/docs/postgresql-deployment-runbook.md)
- [Payment safety](server/docs/postgresql-payment-safety.md)
