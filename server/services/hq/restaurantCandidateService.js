'use strict';

// YAAM HQ — «Кого ждём» (после Stage 28, раздел 2 задания).
//
// НЕ ресторан и не подтаблица restaurants: только название, кухня и счётчик
// голосов клиентского голосования "Какой ресторан вы ждёте в YAAM?" на
// главной странице. До этой миграции список жил захардкоженным в
// client/js/data.js (CANDIDATE_RESTAURANTS, "Демо-цифры голосов; список и
// цифры замените реальными кандидатами при запуске") — единственный
// источник истины теперь restaurant_candidates (db/postgresql/migrations/
// 0007_restaurant_candidates.sql), управляемый отсюда и из HQ; клиент
// получает список публичным чтением (routes/postgresql/api.js), не
// собственной копией данных — задание, раздел 3 "не создавай дублирующий
// функционал".
const db = require('../../db/postgresql');

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

// Голосование за будущее подключение — сортировка по числу голосов по
// убыванию естественна и для HQ, и для клиента.
async function listCandidates() {
  return db.query('SELECT * FROM restaurant_candidates ORDER BY votes DESC, id ASC');
}

async function getCandidateById(id) {
  const rows = await db.query('SELECT * FROM restaurant_candidates WHERE id = $1', [id]);
  return rows[0] || null;
}

// Задание, раздел 2.3: форма — ТОЛЬКО название и кухня. Никаких
// фото/меню/блюд/адреса/часов/доставки/статуса — это не ресторан.
async function createCandidate({ name, cuisine }) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) throw new ValidationError('Название обязательно.');
  const trimmedCuisine = String(cuisine || '').trim();
  const rows = await db.query(
    'INSERT INTO restaurant_candidates (name, cuisine) VALUES ($1, $2) RETURNING *',
    [trimmedName, trimmedCuisine],
  );
  return rows[0];
}

// Задание, раздел 2.4: "Логика: создали вариант -> появился в голосовании;
// удалили -> исчез из голосования" — без статусов, без мягкого удаления.
async function deleteCandidate(id) {
  await db.execute('DELETE FROM restaurant_candidates WHERE id = $1', [id]);
}

// Stage 29.1, п.3 — реальное персистентное голосование. deviceId — анонимный
// случайный идентификатор с клиента (localStorage), НЕ персональные данные.
//
// Правило "один голос с устройства на кандидата, повторный не увеличивает
// счётчик" реализовано ДВАЖДЫ, намеренно избыточно:
//   1. UNIQUE(candidate_id, device_id) на restaurant_candidate_votes —
//      единственная НАСТОЯЩАЯ защита, работает даже под гонкой двух
//      параллельных запросов с разных соединений (ON CONFLICT DO NOTHING
//      ниже просто НЕ вставляет вторую строку — атомарно, на уровне БД).
//   2. SELECT ... FOR UPDATE строки кандидата — не обязателен для
//      корректности (её уже даёт (1)), но сериализует конкурентные голоса
//      ЗА ОДНОГО кандидата, чтобы второй параллельный запрос не тратил
//      работу впустую, ожидая исхода первого, вместо гонки за один и тот
//      же UPDATE votes = votes + 1.
//
// Удалённый кандидат: SELECT ... FOR UPDATE на несуществующей строке не
// находит ничего -> ValidationError -> голос отклонён. ON DELETE CASCADE на
// restaurant_candidate_votes дополнительно гарантирует, что у удалённого
// кандидата в принципе не может остаться ни одной строки голосов.
async function castVote(candidateId, deviceId) {
  const trimmedDeviceId = String(deviceId || '').trim();
  if (!trimmedDeviceId) throw new ValidationError('Не удалось определить устройство.');
  if (trimmedDeviceId.length > 128) throw new ValidationError('Некорректный идентификатор устройства.');
  // Некорректный/нечисловой id — тот же честный "не найден", а не сырая
  // ошибка типа PostgreSQL ("invalid input syntax for type integer").
  const numericId = Number(candidateId);
  if (!Number.isInteger(numericId) || numericId <= 0) throw new ValidationError('Кандидат не найден.');

  return db.transaction(async (client) => {
    const candidateRows = await db.query(
      'SELECT id FROM restaurant_candidates WHERE id = $1 FOR UPDATE',
      [numericId],
      client,
    );
    if (!candidateRows[0]) throw new ValidationError('Кандидат не найден.');

    const inserted = await db.query(
      `INSERT INTO restaurant_candidate_votes (candidate_id, device_id)
       VALUES ($1, $2)
       ON CONFLICT (candidate_id, device_id) DO NOTHING
       RETURNING id`,
      [numericId, trimmedDeviceId],
      client,
    );

    if (inserted.length === 0) {
      // Это устройство уже голосовало за этого кандидата — идемпотентный
      // no-op, НЕ ошибка (задание: "повторный голос... не увеличивает счётчик").
      const current = await db.query('SELECT votes FROM restaurant_candidates WHERE id = $1', [numericId], client);
      return { alreadyVoted: true, votes: current[0].votes };
    }

    const updated = await db.query(
      'UPDATE restaurant_candidates SET votes = votes + 1 WHERE id = $1 RETURNING votes',
      [numericId],
      client,
    );
    return { alreadyVoted: false, votes: updated[0].votes };
  });
}

module.exports = { ValidationError, listCandidates, getCandidateById, createCandidate, deleteCandidate, castVote };
