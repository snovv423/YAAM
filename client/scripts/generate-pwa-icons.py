#!/usr/bin/env python3
"""Генерация PWA/iOS icon assets YAAM из утверждённого исходника.

Запускается вручную (не часть деплоя) — только когда меняется сам исходник
client/assets/yaam-app-icon-source.jpg. Результат коммитится в репозиторий,
чтобы GitHub Pages отдавал готовые PNG без build-шага.

Требуется Pillow:  python3 -m pip install --user Pillow
Запуск из корня репозитория:  python3 client/scripts/generate-pwa-icons.py

Оба варианта — один и тот же утверждённый визуал, отличается только
масштаб кадра. Пропорции 1:1 сохраняются, знак не растягивается и не
обрезается, тёмное поле вокруг плитки остаётся:

  "any"      — центральный кадр 1/1.18 исходника. Плитка занимает почти весь
               холст, поэтому под squircle-маской iOS иконка YAAM выглядит
               такой же по размеру, как соседние приложения, а не «наклейкой»
               внутри чёрной рамки (исходник отрисован с широким чёрным полем).
  "maskable" — центральный кадр 1/1.10. Кадр чуть шире, чем у "any", ровно
               настолько, чтобы самая дальняя точка неонового знака (верхние
               кончики Y) укладывалась в safe zone maskable-иконки —
               центральную окружность диаметром 80% холста: измеренный
               диаметр знака здесь 0.78 при допустимых 0.80.
"""

import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - вспомогательный скрипт
    sys.exit("Нужен Pillow: python3 -m pip install --user Pillow")

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "yaam-app-icon-source.jpg"
OUT_DIR = ROOT / "assets" / "icons"

ANY_ZOOM = 1.18
MASKABLE_ZOOM = 1.10

# apple-touch-icon и favicon берутся из того же кадра, что "any".
ANY_SIZES = [16, 32, 120, 152, 167, 180, 192, 512]
MASKABLE_SIZES = [192, 512]

NAMES = {16: "favicon-16.png", 32: "favicon-32.png", 180: "apple-touch-icon.png"}


def center_crop(image: Image.Image, zoom: float) -> Image.Image:
    side = int(round(image.width / zoom))
    offset = (image.width - side) // 2
    return image.crop((offset, offset, offset + side, offset + side))


def save(image: Image.Image, size: int, name: str) -> None:
    out = OUT_DIR / name
    image.resize((size, size), Image.LANCZOS).save(out, "PNG", optimize=True)
    print(f"  {out.relative_to(ROOT.parent)}  {size}x{size}  {out.stat().st_size} B")


def main() -> None:
    if not SOURCE.exists():
        sys.exit(f"нет исходника: {SOURCE}")

    src = Image.open(SOURCE).convert("RGB")
    if src.width != src.height:
        sys.exit(f"исходник должен быть квадратным, получено {src.size}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    any_frame = center_crop(src, ANY_ZOOM)
    maskable_frame = center_crop(src, MASKABLE_ZOOM)

    print(f'source {src.size}; any {any_frame.size}; maskable {maskable_frame.size}')
    print('purpose="any" + apple-touch-icon + favicon:')
    for size in ANY_SIZES:
        save(any_frame, size, NAMES.get(size, f"icon-{size}.png"))

    print('purpose="maskable":')
    for size in MASKABLE_SIZES:
        save(maskable_frame, size, f"icon-maskable-{size}.png")


if __name__ == "__main__":
    main()
