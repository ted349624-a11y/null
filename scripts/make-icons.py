# Regenerate the icon set: python3 scripts/make-icons.py (needs Pillow and the DejaVu fonts).
# null_ icon set: the small mark (lime bar on a dark rounded square) and the "null_" wordmark for big sizes.
from PIL import Image, ImageDraw, ImageFont
import os, json, shutil
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend")
os.makedirs(f"{OUT}/icons", exist_ok=True)
BG, WHITE, LIME = (8, 9, 11), (236, 239, 241), (198, 255, 61)
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
S = 8  # supersampling

def mark(size, rounded=True):
    """The tab icon, same geometry as the old inline SVG: 32-unit square, radius 7, bar at x8 y22 w16 h4."""
    n = size * S; u = n / 32
    im = Image.new("RGBA", (n, n), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    if rounded: d.rounded_rectangle([0, 0, n - 1, n - 1], radius=round(7 * u), fill=BG)
    else: d.rectangle([0, 0, n, n], fill=BG)
    d.rectangle([round(8 * u), round(22 * u), round(24 * u), round(26 * u)], fill=LIME)
    return im.resize((size, size), Image.LANCZOS)

def wordmark(size, scale=0.70, rounded=False):
    """'null' in the site's mono bold, with the underscore drawn as a lime bar (like the logo)."""
    n = size * S
    im = Image.new("RGBA", (n, n), BG + (255,)); d = ImageDraw.Draw(im)
    if rounded:
        im = Image.new("RGBA", (n, n), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
        d.rounded_rectangle([0, 0, n - 1, n - 1], radius=round(n * 0.22), fill=BG)
    target_w = n * scale                       # "null_" (5 cells) fills this width
    fs = 10; f = ImageFont.truetype(FONT, fs)
    while f.getlength("M") * 5 < target_w: fs += 2; f = ImageFont.truetype(FONT, fs)
    adv = f.getlength("M"); asc, _ = f.getmetrics()
    _, top, _, bottom = f.getbbox("null")
    x0 = (n - adv * 5) / 2
    y0 = n / 2 - (top + bottom) / 2 - adv * 0.05
    d.text((x0, y0), "null", font=f, fill=WHITE)
    base = y0 + asc
    bar_h = max(1, round(fs * 0.11))
    d.rectangle([round(x0 + 4 * adv + adv * 0.06), round(base + fs * 0.02), round(x0 + 5 * adv - adv * 0.06), round(base + fs * 0.02 + bar_h)], fill=LIME)
    return im.resize((size, size), Image.LANCZOS)

# tab icons
svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#08090b"/><rect x="8" y="22" width="16" height="4" fill="#c6ff3d"/></svg>\n'
open(f"{OUT}/icons/favicon.svg", "w").write(svg)
mark(16).save(f"{OUT}/icons/favicon-16.png"); mark(32).save(f"{OUT}/icons/favicon-32.png")
m48 = mark(48); m48.save(f"{OUT}/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
# home screen / app icons (opaque: iOS and Android round them themselves)
wordmark(180).convert("RGB").save(f"{OUT}/apple-touch-icon.png")
shutil.copy(f"{OUT}/apple-touch-icon.png", f"{OUT}/apple-touch-icon-precomposed.png")
wordmark(192).convert("RGB").save(f"{OUT}/icons/icon-192.png")
wordmark(512).convert("RGB").save(f"{OUT}/icons/icon-512.png")
wordmark(512, scale=0.52).convert("RGB").save(f"{OUT}/icons/icon-maskable-512.png")  # inside the 80% safe zone
manifest = {
    "name": "null_ — NFTs with their own coin", "short_name": "null_", "start_url": "/", "scope": "/",
    "display": "standalone", "background_color": "#08090b", "theme_color": "#08090b",
    "icons": [
        {"src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
        {"src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png"},
        {"src": "/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
    ],
}
open(f"{OUT}/site.webmanifest", "w").write(json.dumps(manifest, indent=2) + "\n")

# review sheet
sheet = Image.new("RGB", (900, 330), (40, 40, 44))
x = 20
for im, label in [(mark(16), 16), (mark(32), 32), (mark(48), 48), (Image.open(f"{OUT}/apple-touch-icon.png"), 180)]:
    big = im if im.size[0] >= 180 else im.resize((im.size[0] * 3, im.size[1] * 3), Image.NEAREST)
    sheet.paste(big, (x, 20), big if big.mode == "RGBA" else None); x += big.size[0] + 20
mk = Image.open(f"{OUT}/icons/icon-maskable-512.png").resize((180, 180), Image.LANCZOS)
circle = Image.new("L", (180, 180), 0); ImageDraw.Draw(circle).ellipse([0, 0, 179, 179], fill=255)
sheet.paste(mk, (x, 20), circle)
ios = Image.open(f"{OUT}/apple-touch-icon.png").resize((120, 120), Image.LANCZOS)
rr = Image.new("L", (120, 120), 0); ImageDraw.Draw(rr).rounded_rectangle([0, 0, 119, 119], radius=27, fill=255)
sheet.paste(ios, (20, 200), rr)
if os.environ.get("ICON_SHEET"): sheet.save(os.environ["ICON_SHEET"])
print("done:", sorted(os.listdir(f"{OUT}/icons")), [f for f in os.listdir(OUT) if f.startswith(("favicon", "apple", "site"))])
