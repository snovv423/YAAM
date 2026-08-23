import type { Page } from '@playwright/test';

// Единственное место, где e2e связывает реальный client/js/api.js с локальным
// эфемерным backend'ом.
//
// Почему отдельный файл. Раньше эта функция была скопирована в трёх spec'ах
// и ставила глобал `window.YAAM_API_BASE_URL`. После production-cutover
// api.js перестал его читать вовсе (см. client/test/productionApiCutover.test.js,
// кейс "legacy public YAAM_API_BASE_URL override cannot redirect requests away
// from production" — инертность этого глобала теперь защищена тестом). Ни одна
// из трёх копий обновлена не была, и клиент в e2e молча уходил на
// https://api.yaam.su: тесты падали на «Не удалось загрузить рестораны», так и
// не дойдя до проверяемых сценариев. Одна общая функция вместо трёх копий —
// чтобы следующее изменение контракта нельзя было применить наполовину.
//
// Актуальный контракт api.js (resolveApiBaseUrl):
//   window.__YAAM_TEST_MODE__ === true            — явное признание тестового режима
//   window.__YAAM_TEST_API_BASE_URL               — сам адрес (проверяется через
//                                                   hasOwnProperty, поэтому обязан
//                                                   быть собственным свойством)
// Публичный runtime не выставляет ни то, ни другое, поэтому браузер на yaam.su
// всегда получает production API.
export const TEST_API_HOOK_FLAG = '__YAAM_TEST_MODE__';
export const TEST_API_HOOK_URL = '__YAAM_TEST_API_BASE_URL';

// Fail-closed: тестовый режим разрешено включать только против локального
// эфемерного backend'а. Если из-за ошибки в конфигурации сюда прилетит
// staging/production-адрес, тест обязан упасть здесь, а не начать гонять
// сценарии создания заказов по реальному API.
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function assertLocalBackend(apiBaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(apiBaseUrl);
  } catch {
    throw new Error(`e2e: невалидный API base URL: ${apiBaseUrl}`);
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `e2e: тестовый режим клиента разрешён только против локального backend'а, получено ${parsed.origin}`
    );
  }
  return parsed;
}

export async function pointFrontendAtLocalBackend(page: Page, apiBaseUrl: string): Promise<void> {
  assertLocalBackend(apiBaseUrl);
  await page.addInitScript(
    ({ flag, urlKey, value }: { flag: string; urlKey: string; value: string }) => {
      // addInitScript выполняется до любого скрипта документа, поэтому оба
      // свойства уже стоят к моменту, когда api.js вычисляет API_BASE_URL.
      (window as unknown as Record<string, unknown>)[flag] = true;
      (window as unknown as Record<string, unknown>)[urlKey] = value;
    },
    { flag: TEST_API_HOOK_FLAG, urlKey: TEST_API_HOOK_URL, value: apiBaseUrl }
  );
}
