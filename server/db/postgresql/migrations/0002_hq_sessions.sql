-- 0002_hq_sessions — хранилище HQ-сессий в PostgreSQL.
--
-- До Stage 15 сессии жили в MemoryStore внутри процесса: перезапуск
-- приложения разлогинивал владельца, истёкшие записи никогда не удалялись,
-- а два процесса не видели сессии друг друга. Для production это блокер.
--
-- Таблица намеренно простая: идентификатор, тело сессии и срок. Пароля здесь
-- нет и быть не может — в сессии лежат только hqUser, версия учётных данных
-- и CSRF-токен.
CREATE TABLE IF NOT EXISTS hq_sessions (
  sid TEXT PRIMARY KEY,
  sess JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

-- Индекс по сроку: по нему идёт и проверка «не истекла ли», и фоновая
-- очистка. Без него обе операции превращались бы в полный скан.
CREATE INDEX IF NOT EXISTS ix_hq_sessions_expires ON hq_sessions (expires_at);
