'use strict';

// YAAM HQ Stage 5A — юнит-тесты чистой логики меню/блюд: валидация
// категории/блюда, денежные и БЖУ-лимиты, безопасный photo_url, safe diff
// для audit log. Тот же принцип, что и test/hqRestaurantAdmin.test.js
// (Stage 4) — ни один тест не обращается к PostgreSQL. Реальные INSERT/
// UPDATE и ownership-проверки — в test/postgresql/hqMenuAdminStage5A.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCategoryInput,
  parseMenuItemInput,
  normalizePrice,
  normalizeOptionalNonNegativeInt,
  normalizePhotoUrl,
  CATEGORY_NAME_MAX,
  ITEM_NAME_MAX,
  PRICE_MAX,
} = require('../services/hq/menuAdminService');
const { ValidationError } = require('../services/hq/restaurantLifecycle');
const { summarizeMenuItemDiff, summarizeCategoryDiff } = require('../services/hq/auditLog');

// ---------------------------------------------------------------------------
// Категория
// ---------------------------------------------------------------------------

test('parseCategoryInput: пустое название отклоняется', () => {
  assert.throws(() => parseCategoryInput({ name: '' }), ValidationError);
  assert.throws(() => parseCategoryInput({ name: '   ' }), ValidationError);
});

test('parseCategoryInput: обрезает пробелы', () => {
  assert.equal(parseCategoryInput({ name: '  Горячее  ' }).name, 'Горячее');
});

test('parseCategoryInput: превышение лимита длины отклоняется', () => {
  assert.throws(() => parseCategoryInput({ name: 'x'.repeat(CATEGORY_NAME_MAX + 1) }), ValidationError);
  assert.doesNotThrow(() => parseCategoryInput({ name: 'x'.repeat(CATEGORY_NAME_MAX) }));
});

test('parseCategoryInput: свободные названия без enum — любые строки допустимы', () => {
  for (const name of ['Завтраки', 'Хинкал', 'Специальное предложение', 'Напитки 18+']) {
    assert.equal(parseCategoryInput({ name }).name, name);
  }
});

// ---------------------------------------------------------------------------
// Цена
// ---------------------------------------------------------------------------

test('normalizePrice: отрицательная цена отклоняется', () => {
  assert.throws(() => normalizePrice(-1), ValidationError);
  assert.throws(() => normalizePrice('-100'), ValidationError);
});

test('normalizePrice: 0 допустим (например, бесплатный соус/добавка)', () => {
  assert.equal(normalizePrice(0), 0);
  assert.equal(normalizePrice('0'), 0);
});

test('normalizePrice: дробная цена отклоняется — целые рубли, не float', () => {
  assert.throws(() => normalizePrice(99.5), ValidationError);
});

test('normalizePrice: превышение верхнего лимита отклоняется', () => {
  assert.throws(() => normalizePrice(PRICE_MAX + 1), ValidationError);
  assert.doesNotThrow(() => normalizePrice(PRICE_MAX));
});

test('normalizePrice: нечисловое значение отклоняется', () => {
  assert.throws(() => normalizePrice('бесплатно'), ValidationError);
  assert.throws(() => normalizePrice(undefined), ValidationError);
});

// ---------------------------------------------------------------------------
// БЖУ/вес — опциональные, "пусто" значит "данных нет", не 0
// ---------------------------------------------------------------------------

test('normalizeOptionalNonNegativeInt: пустая строка/undefined -> null, НЕ 0', () => {
  assert.equal(normalizeOptionalNonNegativeInt('', 1000, 'Х'), null);
  assert.equal(normalizeOptionalNonNegativeInt(undefined, 1000, 'Х'), null);
  assert.equal(normalizeOptionalNonNegativeInt(null, 1000, 'Х'), null);
});

test('normalizeOptionalNonNegativeInt: реальный 0 сохраняется как 0, не путается с "нет данных"', () => {
  assert.equal(normalizeOptionalNonNegativeInt(0, 1000, 'Х'), 0);
  assert.equal(normalizeOptionalNonNegativeInt('0', 1000, 'Х'), 0);
});

test('normalizeOptionalNonNegativeInt: отрицательное отклоняется', () => {
  assert.throws(() => normalizeOptionalNonNegativeInt(-5, 1000, 'Белки'), ValidationError);
});

test('normalizeOptionalNonNegativeInt: превышение лимита отклоняется', () => {
  assert.throws(() => normalizeOptionalNonNegativeInt(2001, 2000, 'Белки'), ValidationError);
});

test('normalizeOptionalNonNegativeInt: дробное отклоняется', () => {
  assert.throws(() => normalizeOptionalNonNegativeInt(10.5, 1000, 'Вес'), ValidationError);
});

// ---------------------------------------------------------------------------
// photo_url — легаси-поле, только валидация формата (не загрузка файла)
// ---------------------------------------------------------------------------

test('normalizePhotoUrl: пустая строка допустима (фото необязательно)', () => {
  assert.equal(normalizePhotoUrl(''), '');
  assert.equal(normalizePhotoUrl(undefined), '');
});

test('normalizePhotoUrl: обычный https URL проходит', () => {
  assert.equal(normalizePhotoUrl('https://example.com/photo.jpg'), 'https://example.com/photo.jpg');
});

test('normalizePhotoUrl: javascript:/data: схемы отклоняются (XSS-защита)', () => {
  assert.throws(() => normalizePhotoUrl('javascript:alert(1)'), ValidationError);
  assert.throws(() => normalizePhotoUrl('data:text/html,<script>alert(1)</script>'), ValidationError);
});

test('normalizePhotoUrl: некорректный URL отклоняется', () => {
  assert.throws(() => normalizePhotoUrl('не ссылка'), ValidationError);
});

test('normalizePhotoUrl: опасные символы в пути percent-encode\'ятся — атрибутный breakout невозможен', () => {
  const result = normalizePhotoUrl('http://evil.com/" onerror="alert(1)');
  assert.ok(!result.includes('"'), 'результат не должен содержать сырую двойную кавычку');
  assert.match(result, /%22/);
});

// ---------------------------------------------------------------------------
// Блюдо
// ---------------------------------------------------------------------------

test('parseMenuItemInput: пустое название отклоняется', () => {
  assert.throws(() => parseMenuItemInput({ name: '', category_id: '1', price: '100' }), ValidationError);
});

test('parseMenuItemInput: без категории отклоняется', () => {
  assert.throws(() => parseMenuItemInput({ name: 'Чай', category_id: '', price: '100' }), ValidationError);
  assert.throws(() => parseMenuItemInput({ name: 'Чай', category_id: 'abc', price: '100' }), ValidationError);
});

test('parseMenuItemInput: превышение лимита названия отклоняется', () => {
  assert.throws(() => parseMenuItemInput({ name: 'x'.repeat(ITEM_NAME_MAX + 1), category_id: '1', price: '100' }), ValidationError);
});

test('parseMenuItemInput: свободное название — блюдо/напиток/десерт/товар, без enum типа', () => {
  for (const name of ['Шашлык из баранины', 'Компот', 'Соус чесночный', 'Хлеб лаваш', 'Комбо-набор №1']) {
    const result = parseMenuItemInput({ name, category_id: '1', price: '100' });
    assert.equal(result.name, name);
  }
});

test('parseMenuItemInput: валидный полный ввод нормализуется корректно', () => {
  const result = parseMenuItemInput({
    name: '  Шашлык из баранины  ', category_id: '3', price: '650',
    description: 'Сочный шашлык', composition: 'баранина, лук, специи',
    weight_g: '300', kcal: '540', protein_g: '25', fat_g: '40', carbs_g: '5',
    photo_url: '',
  });
  assert.deepEqual(result, {
    name: 'Шашлык из баранины', categoryId: 3, price: 650,
    description: 'Сочный шашлык', composition: 'баранина, лук, специи', photoUrl: '',
    weightG: 300, kcal: 540, proteinG: 25, fatG: 40, carbsG: 5,
  });
});

test('parseMenuItemInput: БЖУ не обязательны — блюдо без них валидно (владелец может их не знать)', () => {
  const result = parseMenuItemInput({ name: 'Чай чёрный', category_id: '1', price: '80' });
  assert.equal(result.weightG, null);
  assert.equal(result.kcal, null);
  assert.equal(result.proteinG, null);
  assert.equal(result.fatG, null);
  assert.equal(result.carbsG, null);
});

// ---------------------------------------------------------------------------
// Audit log — safe diff
// ---------------------------------------------------------------------------

test('summarizeMenuItemDiff: null, если ничего не изменилось', () => {
  const row = { name: 'A', price: 100, description: 'd' };
  assert.equal(summarizeMenuItemDiff(row, row), null);
});

test('summarizeMenuItemDiff: composition НИКОГДА не попадает в diff, даже если изменилась (может быть длинным текстом)', () => {
  const before = { name: 'A', composition: 'старый длинный состав' };
  const after = { name: 'A', composition: 'новый длинный состав' };
  assert.equal(summarizeMenuItemDiff(before, after), null);
});

test('summarizeMenuItemDiff: photo_url никогда не попадает в diff', () => {
  const before = { name: 'A', photo_url: 'https://old.example/a.jpg' };
  const after = { name: 'A', photo_url: 'https://new.example/b.jpg' };
  assert.equal(summarizeMenuItemDiff(before, after), null);
});

test('summarizeMenuItemDiff: цена журналируется как before -> after', () => {
  const diff = summarizeMenuItemDiff({ name: 'A', price: 100 }, { name: 'A', price: 150 });
  assert.match(diff, /price: "100" -> "150"/);
});

test('summarizeMenuItemDiff: длинное значение обрезается разумным лимитом', () => {
  const longName = 'x'.repeat(200);
  const diff = summarizeMenuItemDiff({ name: 'y' }, { name: longName });
  assert.ok(diff.length < 200, 'diff-строка должна быть короче исходного значения');
  assert.match(diff, /…/);
});

test('summarizeCategoryDiff: только name в allowlist', () => {
  const diff = summarizeCategoryDiff({ name: 'Старое', archived_at: null }, { name: 'Новое', archived_at: new Date() });
  assert.match(diff, /name: "Старое" -> "Новое"/);
  assert.doesNotMatch(diff, /archived_at/);
});
