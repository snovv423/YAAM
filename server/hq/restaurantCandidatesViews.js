'use strict';

// YAAM HQ — «Кого ждём» (после Stage 28, раздел 2 задания). Тот же принцип,
// что и весь остальной HQ (server/hq/layout.js): шаблонные функции без
// движка/фреймворка, esc() на каждое значение из БД.
const { esc } = require('./layout');

function simpleActionForm({ action, csrfToken, label, cls, confirm: confirmMsg }) {
  const onsubmit = confirmMsg ? ` onsubmit="return confirm('${esc(confirmMsg)}')"` : '';
  return `<form method="post" action="${action}"${onsubmit} style="display:inline">
      <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
      <button type="submit"${cls ? ` class="${cls}"` : ''}>${esc(label)}</button>
    </form>`;
}

function renderActionBanner({ error, notice }) {
  if (error) return `<div class="error" style="margin-bottom:14px">${esc(error)}</div>`;
  if (notice) return `<div class="notice" style="margin-bottom:14px">${esc(notice)}</div>`;
  return '';
}

// Задание, раздел 2.2 — ровно три поля на карточку: название, кухня,
// количество голосов, плюс кнопка удаления. Без статусов (раздел 2.4).
function renderCandidateCard(candidate, { linkBasePath, csrfToken }) {
  return `
    <div class="rest-card">
      <div class="rest-card-main">
        <div class="rest-card-title">${esc(candidate.name)}</div>
        <div class="rest-card-meta">
          ${candidate.cuisine ? `<span>${esc(candidate.cuisine)}</span> · ` : ''}
          <span>${candidate.votes} голосов</span>
        </div>
      </div>
      ${simpleActionForm({
        action: `${linkBasePath}/restaurants/candidates/${candidate.id}/delete`,
        csrfToken,
        label: 'Удалить',
        cls: 'btn compact ghost',
        confirm: `Удалить «${candidate.name}» из голосования?`,
      })}
    </div>`;
}

function renderCandidatesPage({ candidates, error, notice, linkBasePath, csrfToken }) {
  return `
    <h1>Кого ждём</h1>
    <div class="empty-state" style="margin:0 0 16px">
      Отдельный список кандидатов для голосования на главной странице клиента
      ("Какой ресторан вы ждёте в YAAM?") — не рестораны YAAM.
    </div>
    ${renderActionBanner({ error, notice })}
    <div class="panel">
      <div class="panel-title">Добавить кандидата</div>
      <form method="post" action="${linkBasePath}/restaurants/candidates">
        <input type="hidden" name="_csrf" value="${esc(csrfToken)}">
        <label for="cand-name">Название ресторана</label>
        <input id="cand-name" name="name" type="text" required autocomplete="off">
        <label for="cand-cuisine">Кухня</label>
        <input id="cand-cuisine" name="cuisine" type="text" autocomplete="off">
        <button type="submit" class="btn compact" style="margin-top:10px">Сохранить</button>
      </form>
    </div>
    ${candidates.length
      ? `<div class="rest-list">${candidates.map((c) => renderCandidateCard(c, { linkBasePath, csrfToken })).join('')}</div>`
      : '<div class="panel"><div class="empty-state">Кандидатов пока нет.</div></div>'}
    <a class="btn ghost compact" href="${linkBasePath}/restaurants" style="margin-top:16px;display:inline-block">← К ресторанам</a>
  `;
}

module.exports = { renderCandidatesPage };
