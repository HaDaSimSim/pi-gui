#!/usr/bin/env python3
# 폰트의 π(U+03C0) 글리프를 SVG path 로 추출해 아이콘 SVG 를 만든다.
# fontforge 없이 fonttools 만으로. 폰트 의존성을 없애려고 글리프를 outline path 로 박는다.

import sys
from fontTools.ttLib import TTFont, TTCollection
from fontTools.pens.svgPathPen import SVGPathPen


def load_font(path, want_bold=True):
    if path.endswith(".ttc"):
        coll = TTCollection(path)
        # 가능하면 Bold 페이스를 고른다.
        best = coll.fonts[0]
        for f in coll.fonts:
            name = " ".join(str(r) for r in f["name"].names if r.nameID in (2, 17))
            if "bold" in name.lower():
                best = f
                break
        return best
    return TTFont(path)


def glyph_to_svg(font_path, out_path, char="π", canvas=1024, target_glyph_frac=0.46):
    font = load_font(font_path)
    upm = font["head"].unitsPerEm
    cmap = font.getBestCmap()
    code = ord(char)
    if code not in cmap:
        print(f"  ! U+{code:04X} not in {font_path}")
        return False
    gname = cmap[code]
    glyph_set = font.getGlyphSet()

    pen = SVGPathPen(glyph_set)
    glyph_set[gname].draw(pen)
    d = pen.getCommands()
    if not d.strip():
        print(f"  ! empty outline for {char} in {font_path}")
        return False

    # 글리프 바운딩박스 (font units). glyf or CFF.
    try:
        bounds_pen = font.getGlyphSet()
        from fontTools.pens.boundsPen import BoundsPen

        bp = BoundsPen(glyph_set)
        glyph_set[gname].draw(bp)
        xmin, ymin, xmax, ymax = bp.bounds
    except Exception as e:
        print("  ! bounds fail", e)
        return False

    gw = xmax - xmin
    gh = ymax - ymin
    # 글리프를 캔버스의 target_glyph_frac 비율 크기로 스케일.
    scale = (canvas * target_glyph_frac) / max(gw, gh)
    # 폰트는 y-up, SVG 는 y-down → y 뒤집기.
    # 중앙 정렬: 글리프 중심을 캔버스 중심에 둔다.
    cx = (xmin + xmax) / 2
    cy = (ymin + ymax) / 2
    tx = canvas / 2 - cx * scale
    ty = canvas / 2 + cy * scale  # y 뒤집어서 +

    transform = f"translate({tx:.2f} {ty:.2f}) scale({scale:.4f} {-scale:.4f})"

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{canvas}" height="{canvas}" viewBox="0 0 {canvas} {canvas}">
  <rect width="{canvas}" height="{canvas}" rx="220" fill="#0b0b0f"/>
  <g transform="{transform}" fill="#e6e6e6">
    <path d="{d}"/>
  </g>
</svg>
'''
    with open(out_path, "w") as f:
        f.write(svg)
    print(f"  ok → {out_path}  (upm={upm}, glyph={gname}, scale={scale:.4f})")
    return True


if __name__ == "__main__":
    fonts = {
        "blexmono": "/Users/mingeon/Library/Fonts/BlexMonoNerdFontMono-Bold.ttf",
        "intercjk": "/Users/mingeon/Library/Fonts/InterCJK-Bold.otf",
    }
    for key, path in fonts.items():
        out = f"/Users/mingeon/projects/pi-web/src-tauri/icon-{key}.svg"
        print(f"{key}:")
        glyph_to_svg(path, out)
