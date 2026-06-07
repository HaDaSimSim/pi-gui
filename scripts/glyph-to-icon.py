#!/usr/bin/env python3
# Extract the font's π(U+03C0) glyph as an SVG path to build an icon SVG.
# Using only fonttools, no fontforge. Embeds the glyph as an outline path to remove the font dependency.

import sys
from fontTools.ttLib import TTFont, TTCollection
from fontTools.pens.svgPathPen import SVGPathPen


def load_font(path, want_bold=True):
    if path.endswith(".ttc"):
        coll = TTCollection(path)
        # Pick the Bold face if possible.
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

    # Glyph bounding box (font units). glyf or CFF.
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
    # Scale the glyph to target_glyph_frac of the canvas size.
    scale = (canvas * target_glyph_frac) / max(gw, gh)
    # Fonts are y-up, SVG is y-down -> flip y.
    # Center alignment: place the glyph center at the canvas center.
    cx = (xmin + xmax) / 2
    cy = (ymin + ymax) / 2
    tx = canvas / 2 - cx * scale
    ty = canvas / 2 + cy * scale  # + because y is flipped

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
    # Usage: glyph-to-icon.py <font-path> [out-svg]
    # Or set ICON_FONT (path) and optionally ICON_OUT_DIR (default: <repo>/src-tauri).
    import os

    args = sys.argv[1:]
    font_path = args[0] if args else os.environ.get("ICON_FONT")
    if not font_path:
        print(
            "error: no font given.\n"
            "  usage: glyph-to-icon.py <font-path> [out-svg]\n"
            "  or:    ICON_FONT=/path/to/font.ttf glyph-to-icon.py",
            file=sys.stderr,
        )
        sys.exit(2)

    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(script_dir)
    out_dir = os.environ.get("ICON_OUT_DIR", os.path.join(repo_root, "src-tauri"))

    if len(args) > 1:
        out_path = args[1]
    else:
        base = os.path.splitext(os.path.basename(font_path))[0]
        out_path = os.path.join(out_dir, f"icon-{base}.svg")

    glyph_to_svg(font_path, out_path)
