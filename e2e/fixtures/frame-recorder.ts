import type { Page } from '@playwright/test';

// Покадровая запись того, что реально было на экране, начиная с самого первого
// кадра документа.
//
// Зачем отдельная фикстура, а не пара строк в spec'е. Во-первых, «главная не
// мелькнула» нельзя проверить ни ожиданием селектора, ни скриншотом по
// требованию: вспышка живёт один-два кадра и к моменту любого await уже
// закончилась — нужен наблюдатель, поставленный ДО документа. Во-вторых,
// e2e-обвязка держит правило: addInitScript живёт только в fixtures/
// (client/test/e2eTestApiHookContract.test.js) — оно появилось после того, как
// три копии API-хука в spec'ах разъехались с api.js и молча уводили браузер на
// production. Любой init-скрипт заводится здесь же, чтобы правило оставалось
// простым и проверяемым.
export type ScreenFrame = {
  home: boolean;
  dish: boolean;
  menu: boolean;
  guard: boolean;
  t: number;
};

export async function recordFramesFromStart(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const frames: unknown[] = [];
    (window as unknown as Record<string, unknown>).__yaamFrames = frames;
    const visible = (id: string) => {
      const el = document.getElementById(id);
      if (!el) return false;
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(el).display !== 'none';
    };
    const tick = () => {
      frames.push({
        home: visible('home'),
        dish: visible('dish'),
        menu: visible('menu'),
        guard: document.documentElement.classList.contains('route-boot'),
        t: Math.round(performance.now()),
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export async function capturedFrames(page: Page): Promise<ScreenFrame[]> {
  return page.evaluate(
    () => (window as unknown as Record<string, unknown>).__yaamFrames as ScreenFrame[]
  );
}
