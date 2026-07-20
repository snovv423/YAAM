'use strict';

// Минимальный fake-double для node-telegram-bot-api, реализующий ровно то
// подмножество API, которое использует server/bot/postgresql/index.js:
// onText/on/sendMessage/editMessageText/answerCallbackQuery. Не открывает
// ни одного сетевого соединения, не требует реального Telegram token — тем
// самым покрывает явное требование задания Stage 3 "не требовать реального
// Telegram token" / "не отправлять реальные сообщения пользователям".
//
// ВАЖНО: реальный EventEmitter.emit() (и в node-telegram-bot-api, и в
// pgOrderService.orderEvents) НЕ ждёт async-слушателей — поэтому этот fake
// намеренно НЕ использует node:events для диспетчеризации: triggerText()/
// triggerCallbackQuery() вызывают зарегистрированный обработчик НАПРЯМУЮ и
// await его возвращаемый промис, что детерминированно даёт тестам дождаться
// завершения асинхронной обработки без polling/sleep (bot/postgresql/index.js
// специально возвращает промис из своих on('callback_query', ...)-обработчиков
// именно ради этого).

if (process.env.NODE_ENV !== 'test') {
  throw new Error('server/test/postgresql/helpers/fakeTelegramBot.js requires NODE_ENV=test');
}

class FakeTelegramBot {
  constructor() {
    this.textHandlers = [];
    this.eventHandlers = {};
    this.sentMessages = [];
    this.editedMessages = [];
    this.answeredCallbacks = [];
    this._messageIdSeq = 1;
    this.stopPollingCalls = [];

    // Точки инъекции сбоя Telegram API — тесты подменяют перед вызовом,
    // не трогая остальную логику фейка.
    this.sendMessageImpl = null;
    this.editMessageTextImpl = null;
    this.answerCallbackQueryImpl = null;
  }

  onText(regex, cb) {
    this.textHandlers.push({ regex, cb });
  }

  on(event, cb) {
    (this.eventHandlers[event] ||= []).push(cb);
    return this;
  }

  async sendMessage(chatId, text, opts) {
    if (this.sendMessageImpl) return this.sendMessageImpl(chatId, text, opts);
    return this._defaultSendMessage(chatId, text, opts);
  }

  // Пропускает sendMessageImpl-перехват — для тестов, которым нужно
  // "провалить N-й вызов, затем вести себя нормально" без риска
  // рекурсии/бесконечного вызова через сам себя же перехваченный sendMessage.
  async _defaultSendMessage(chatId, text, opts) {
    const messageId = this._messageIdSeq++;
    const record = { chatId: String(chatId), text, opts, messageId };
    this.sentMessages.push(record);
    return { chat: { id: chatId }, message_id: messageId, text };
  }

  async editMessageText(text, opts) {
    if (this.editMessageTextImpl) return this.editMessageTextImpl(text, opts);
    this.editedMessages.push({ text, opts });
    return { message_id: opts.message_id, text };
  }

  async answerCallbackQuery(id, opts) {
    if (this.answerCallbackQueryImpl) return this.answerCallbackQueryImpl(id, opts);
    this.answeredCallbacks.push({ id, opts });
    return true;
  }

  async stopPolling(options) {
    this.stopPollingCalls.push(options);
  }

  // --- Симуляция входящих Telegram update'ов ---

  async triggerText(chatId, text) {
    for (const { regex, cb } of this.textHandlers) {
      const match = regex.exec(text);
      if (match) {
        await cb({ chat: { id: chatId }, text }, match);
        return true;
      }
    }
    return false;
  }

  async triggerCallbackQuery({ id, data, chatId, messageId }) {
    const listeners = this.eventHandlers['callback_query'] || [];
    await Promise.all(listeners.map((l) => l({
      id,
      data,
      message: { chat: { id: chatId }, message_id: messageId },
    })));
  }

  triggerPollingError(err) {
    const listeners = this.eventHandlers['polling_error'] || [];
    for (const l of listeners) l(err);
  }

  // --- Test-side утилиты ---

  reset() {
    this.sentMessages = [];
    this.editedMessages = [];
    this.answeredCallbacks = [];
  }
}

module.exports = { FakeTelegramBot };
