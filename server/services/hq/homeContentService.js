'use strict';

// Текст на главной странице сайта, редактируемый владельцем из HQ («Обзор» ->
// «Текст на главной»). Единственное место, знающее и ключи в app_settings, и
// встроенные значения по умолчанию.
//
// ПОЧЕМУ ДЕФОЛТЫ ЖИВУТ ЗДЕСЬ, А НЕ В КЛИЕНТЕ. Клиент не должен содержать этот
// текст вовсе: иначе после правки в HQ в вёрстке остаётся вторая, устаревшая
// копия, и какая из них покажется — зависит от того, успел ли ответ прийти.
// Сервер всегда отдаёт готовую пару строк: либо сохранённую владельцем, либо
// встроенную. Пустой строки наружу не бывает.
const db = require('../../db/postgresql');
const { ValidationError } = require('./restaurantLifecycle');

const NEON_KEY = 'home_neon';
const SUBTEXT_KEY = 'home_subtext';

// Пределы — защита от абсурда, а не продуктовое ограничение: неон это одна
// строка-слоган, подтекст — короткий абзац под ним.
const NEON_MAX = 120;
const SUBTEXT_MAX = 400;

// Текущий текст сайта на момент появления этой настройки: до первой правки
// главная выглядит ровно как раньше.
const DEFAULT_NEON = 'Твой город уже в меню.';
const DEFAULT_SUBTEXT = 'YAAM собирает рестораны твоего города в одном спокойном месте — чтобы не теряться в лишнем шуме.';

// \r\n -> \n, чтобы одна и та же строка из разных браузеров не хранилась
// по-разному; хвостовые пробелы у строк убираются, сами переносы сохраняются —
// владелец может осмысленно разбить подтекст на две строки.
function normalizeText(value, max, fieldLabel) {
  const raw = typeof value === 'string' ? value : '';
  const cleaned = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
  if (!cleaned) throw new ValidationError(`${fieldLabel}: текст не может быть пустым.`);
  if (cleaned.length > max) throw new ValidationError(`${fieldLabel}: не длиннее ${max} символов.`);
  return cleaned;
}

async function readSettings(keys) {
  const rows = await db.query('SELECT key, value FROM app_settings WHERE key = ANY($1::text[])', [keys]);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return map;
}

async function getHomeContent() {
  const map = await readSettings([NEON_KEY, SUBTEXT_KEY]);
  return {
    neon: map.get(NEON_KEY) || DEFAULT_NEON,
    subtext: map.get(SUBTEXT_KEY) || DEFAULT_SUBTEXT,
  };
}

// Оба поля пишутся одной транзакцией: они правятся одной формой и одной
// кнопкой, и половина сохранённого текста — не то состояние, которое кто-то
// хотел бы увидеть на главной.
async function updateHomeContent(body) {
  const neon = normalizeText(body && body.neon, NEON_MAX, 'Неон');
  const subtext = normalizeText(body && body.subtext, SUBTEXT_MAX, 'Подтекст');
  await db.transaction(async (client) => {
    for (const [key, value] of [[NEON_KEY, neon], [SUBTEXT_KEY, subtext]]) {
      await db.execute(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value],
        client,
      );
    }
  });
  return { neon, subtext };
}

module.exports = {
  NEON_KEY,
  SUBTEXT_KEY,
  NEON_MAX,
  SUBTEXT_MAX,
  DEFAULT_NEON,
  DEFAULT_SUBTEXT,
  getHomeContent,
  updateHomeContent,
};
