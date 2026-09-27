#!/usr/bin/env python3
"""生成 MonoSpace 的应用图标（`build/icon.png`）。

为什么用脚本而不是塞一个二进制图进来：图标是**资产**，但要能复现、能微调、能在评审里看懂
「它长什么样、用什么颜色」。所以把画法写下来，产物 `build/icon.png` 入库。

设计：等宽终端意象 —— 品牌蓝圆角方块 + 白色**等宽 M** + 一块块状光标（`M▌`）。
颜色取自应用主题（`src/renderer/src/assets/main.css`：accent `#1E40AF`）。

依赖：只用 Pillow（开发期工具，**不是**应用依赖）。运行：`python3 scripts/make-icon.py`
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ACCENT = (30, 64, 175)  # #1E40AF 与应用 accent 一致
ACCENT_LIGHT = (37, 78, 205)  # #254ECD 顶部略微提亮，避免纯平
WHITE = (255, 255, 255)
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'

SIZE = 1024  # 先画大图再降采样，边缘更干净
OUT = Path(__file__).resolve().parent.parent / 'build' / 'icon.png'


def main() -> None:
    canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    # 圆角方块：自上而下的浅渐变
    radius = int(SIZE * 0.22)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        color = tuple(round(ACCENT_LIGHT[i] + (ACCENT[i] - ACCENT_LIGHT[i]) * t) for i in range(3))
        draw.line([(0, y), (SIZE, y)], fill=(*color, 255))
    mask = Image.new('L', (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=radius, fill=255)
    canvas.putalpha(mask)

    # 等宽 M：字面几何中心略偏左，给右边的光标留位
    font = ImageFont.truetype(FONT, int(SIZE * 0.52))
    box = draw.textbbox((0, 0), 'M', font=font)
    m_w, m_h = box[2] - box[0], box[3] - box[1]
    cursor_w = int(SIZE * 0.085)
    gap = int(SIZE * 0.035)
    total = m_w + gap + cursor_w
    x = (SIZE - total) // 2
    y = (SIZE - m_h) // 2 - box[1]
    draw.text((x - box[0], y), 'M', font=font, fill=WHITE)

    # 块状光标：与 M 的视觉中线对齐，略低于顶端（像终端里正在输入）
    cur_x = x + m_w + gap
    cur_top = int(SIZE * 0.30)
    cur_bottom = int(SIZE * 0.72)
    draw.rounded_rectangle(
        [cur_x, cur_top, cur_x + cursor_w, cur_bottom],
        radius=cursor_w // 3,
        fill=(255, 255, 255, 235),
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.resize((512, 512), Image.LANCZOS).save(OUT)
    print(f'已写出 {OUT}（512×512）')


if __name__ == '__main__':
    main()
