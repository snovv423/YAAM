import type { Page } from '@playwright/test';
import type { FileTransform } from './static-server';

// Единственное место, где e2e связывает реальный client/js/api.js с локальным
// эфемерным backend'ом.
//
// Как это работает сейчас. api.js объявляет адрес обычной константой:
//
//   const API_BASE_URL = 'https://api.yaam.su';
//
// и НИЧЕГО не читает из window. Статический сервер прогона подменяет эту строку
// при отдаче файла (см. createApiBaseUrlTransform ниже), поэтому переключателя
// endpoint'а в публичном бандле не существует вовсе.
//
// Что было раньше и почему изменено. Прежняя схема ставила через
// page.addInitScript() пару window.__YAAM_TEST_MODE__/__YAAM_TEST_API_BASE_URL,
// которую ради тестов приходилось читать в самом api.js — то есть тестовая
// механика уезжала на yaam.su и позволяла переназначить API прямо со страницы.
// Подстановка при отдаче файла держит её целиком в тестовом дереве и, в отличие
// от перехвата запросов (page.route), не зависит от того, отдаёт ли ответ
// service worker: в его кэш попадает уже подменённый файл.
//
// Контракт с api.js защищён быстрым node --test:
// client/test/e2eTestApiHookContract.test.js.
export const API_BASE_URL_DECLARATION = /^const API_BASE_URL = '[^']*';$/m;
export const API_JS_PATH = 'js/api.js';

// Fail-closed: тестовый режим разрешено включать только против локального
// эфемерного backend'а. Если из-за ошибки в конфигурации сюда прилетит
// staging/production-адрес, прогон обязан упасть здесь, а не начать гонять
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

// Какой адрес реально раздаётся прогоном. Через process.env, а не через
// модульную переменную: globalSetup исполняется в главном процессе, а spec'ы —
// в отдельных воркерах, где модуль загружается заново. Playwright официально
// поддерживает передачу таким способом (env воркеров наследуется на момент
// запуска, уже после globalSetup) — тем же механизмом здесь уже передаются
// YAAM_E2E_API_BASE_URL / YAAM_E2E_CLIENT_BASE_URL.
const INSTALLED_ENV_KEY = 'YAAM_E2E_API_HOOK_INSTALLED';

export function createApiBaseUrlTransform(apiBaseUrl: string): FileTransform {
  assertLocalBackend(apiBaseUrl);
  process.env[INSTALLED_ENV_KEY] = apiBaseUrl;
  return (relativePath, source) => {
    if (relativePath !== API_JS_PATH) return null;
    if (!API_BASE_URL_DECLARATION.test(source)) {
      throw new Error(
        `e2e: в ${API_JS_PATH} не найдено объявление \`const API_BASE_URL = '...';\` — `
        + 'подстановка адреса сломана, поправьте fixtures/test-api-hook.ts вместе с api.js'
      );
    }
    return source.replace(
      API_BASE_URL_DECLARATION,
      `const API_BASE_URL = ${JSON.stringify(apiBaseUrl)};`
    );
  };
}

// Сигнатура сохранена: все spec'ы вызывают её перед page.goto(), как и раньше.
// Установку хука она больше не делает (адрес уже подставлен статическим
// сервером) — осталась fail-closed проверка, что прогон настроен именно на
// локальный backend и что подстановка вообще была установлена.
export async function pointFrontendAtLocalBackend(_page: Page, apiBaseUrl: string): Promise<void> {
  assertLocalBackend(apiBaseUrl);
  const installedApiBaseUrl = process.env[INSTALLED_ENV_KEY] ?? null;
  if (installedApiBaseUrl === null) {
    throw new Error(
      'e2e: статический сервер поднят без подстановки API base URL — '
      + 'createApiBaseUrlTransform() должен быть передан в startStaticServer() из globalSetup'
    );
  }
  if (installedApiBaseUrl !== apiBaseUrl) {
    throw new Error(
      `e2e: spec ожидает backend ${apiBaseUrl}, а статический сервер раздаёт ${installedApiBaseUrl}`
    );
  }
}
