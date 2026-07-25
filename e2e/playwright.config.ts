import { defineConfig, devices } from '@playwright/test';

// Единственная скорректированная часть предложенной структуры (см. отчёт
// "YAAM Playwright Critical Order Smoke Report", §3): globalSetup здесь
// возвращает свою собственную teardown-функцию (официально документированный
// паттерн Playwright — "globalSetup can return a function that will be used
// as a globalTeardown"), поэтому отдельного global-teardown.ts не заведено.
// Причина: передавать порты/дескрипторы embedded PostgreSQL и статик-сервера
// между двумя независимыми файлами пришлось бы либо через временный файл на
// диске, либо через process.env — оба варианта хрупче одной замыкающей
// функции, которая просто держит ссылки в памяти того же процесса. Это и
// есть "более надёжное стандартное решение", о котором явно сказано в задании.
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // Один процесс: единственный embedded-backend на весь прогон, тесты внутри
  // файла делят его. Параллелизм здесь не даёт выигрыша (узкое место —
  // единственный локальный сервер), а последовательный порядок делает вывод
  // предсказуемым для чтения отчёта.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  globalSetup: require.resolve('./global-setup'),
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
