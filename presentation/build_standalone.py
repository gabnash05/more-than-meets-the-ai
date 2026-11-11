"""Bundle local slide assets into one offline HTML file using the standard library."""
from base64 import b64encode
from pathlib import Path
import mimetypes
import re

ROOT = Path(__file__).resolve().parent

def data_uri(relative_path: str) -> str:
    path = ROOT / relative_path
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return f"data:{mime};base64,{b64encode(path.read_bytes()).decode('ascii')}"

html = (ROOT / "index.html").read_text(encoding="utf-8")
css = (ROOT / "style.css").read_text(encoding="utf-8")
css = re.sub(r"url\('([^']+)'\)", lambda m: f"url('{data_uri(m[1])}')", css)
script = (ROOT / "slides.js").read_text(encoding="utf-8")
script = script.replace("'assets/game-qr.png'", repr(data_uri("assets/game-qr.png")))
script = script.replace(
    "`assets/guesser-${lossVisible ? 'loss' : 'accuracy'}.png`",
    f"(lossVisible ? '{data_uri('assets/guesser-loss.png')}' : '{data_uri('assets/guesser-accuracy.png')}')",
)
config = (ROOT / "config.js").read_text(encoding="utf-8")
html = html.replace('<link rel="stylesheet" href="style.css">', f"<style>{css}</style>")
html = html.replace('<script src="config.js"></script>', f"<script>{config}</script>")
html = html.replace('<script defer src="slides.js"></script>', "")
html = re.sub(r'src="(assets/[^"]+)"', lambda m: f'src="{data_uri(m[1])}"', html)
html = html.replace("</body>", f"<script>{script}</script></body>")
font_license = (ROOT / "assets" / "OFL.txt").read_text(encoding="utf-8")
html = html.replace("</head>", f"<!-- Bundled IBM Plex Sans font license\n{font_license}\n-->\n</head>")
(ROOT / "More-Than-Meets-the-AI.html").write_text(html, encoding="utf-8")
print("Built More-Than-Meets-the-AI.html")
