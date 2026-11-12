"""Bundle local slide assets into one offline HTML file using the standard library."""
from base64 import b64encode
from pathlib import Path
import mimetypes
import re
import html as html_lib
import json

ROOT = Path(__file__).resolve().parent

def data_uri(relative_path: str) -> str:
    path = ROOT / relative_path
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return f"data:{mime};base64,{b64encode(path.read_bytes()).decode('ascii')}"

def populate_specimens(markup: str, model: str, manifest: Path) -> str:
    """Fill a slide only when all ten exported records and images exist."""
    if not manifest.exists():
        print(f"{model}: specimen export absent; keeping pending slots")
        return markup
    records = [json.loads(line) for line in manifest.read_text(encoding="utf-8").splitlines() if line.strip()]
    groups = [[row for row in records if row.get("bucket") == bucket] for bucket in ("lowest", "highest")]
    if len(records) != 10 or any(len(group) != 5 for group in groups):
        raise ValueError(f"{manifest}: expected exactly five lowest and five highest records")
    cards = []
    classes = set()
    for row in sum(groups, []):
        image_path = row.get("imagePath")
        if not image_path:
            print(f"{model}: export has no image paths; keeping pending slots")
            return markup
        path = ROOT / "assets" / (model.lower() + "-specimen-" + image_path.replace("\\", "/").split("/")[-1])
        if not path.is_file():
            print(f"{model}: image missing ({path}); keeping pending slots")
            return markup
        score = float(row["top1Probability"] if model == "Guesser" else row["score"])
        if not 0 <= score <= 1:
            raise ValueError(f"{manifest}: confidence outside [0, 1]")
        if model == "Guesser":
            classes.add(str(row["className"]))
            correct = "correct" if row["top1Correct"] else "incorrect"
            label = f"True: {row['className']} / predicted: {row['top1Label']} ({correct})"
        else:
            label = f"Encoded: {row.get('encodedTextLabel')} / reviewed: {row.get('reviewedTextLabel')} / origin: {row.get('textLabelOrigin')}"
        mime = mimetypes.guess_type(path.name)[0]
        if not mime or not mime.startswith("image/"):
            raise ValueError(f"{path}: expected an image")
        try:
            uri = path.resolve().relative_to(ROOT.resolve()).as_posix()
        except ValueError as exc:
            raise ValueError(f"{path}: specimen image must be under presentation/") from exc
        if not uri.startswith("assets/"):
            raise ValueError(f"{path}: specimen image must be under presentation/assets/")
        safe_label = html_lib.escape(str(label), quote=True)
        safe_uri = html_lib.escape(uri, quote=True)
        cards.append(f'<div class="specimen"><div class="specimen-image"><img src="{safe_uri}" alt="{safe_label}"></div><span>{safe_label}</span><span>Confidence: {score:.1%}</span></div>')
    if model == "Guesser" and len(classes) != 1:
        raise ValueError(f"{manifest}: Guesser examples must use one class")
    pattern = rf'(<section class="slide specimen-slide" data-label="{model.upper()} / EXAMPLES".*?</section>)'
    match = re.search(pattern, markup, re.DOTALL)
    if not match:
        raise ValueError(f"{model}: example slide missing")
    section = match.group(1)
    placeholder = '<div class="specimen"><div class="specimen-image">Awaiting<br>export</div><span>Label: —</span><span>Confidence: —</span></div>'
    for card in cards:
        section = section.replace(placeholder, card, 1)
    if model == 'Guesser':
        section = section.replace('<h2>Confidence examples</h2>', f'<h2>{html_lib.escape(next(iter(classes)))} / confidence examples</h2>')
    section = section.replace('Example exports are pending. Labels and scores will be shown when verified artifacts are available.',
        'Validation examples / ' + ('model A, stage 10, predicted-class probability' if model == 'Guesser' else 'text-channel score against encoded labels'))
    section = section.replace('These are placeholders, not model predictions. Replace them only with the exported examples and their actual labels and confidence values, and identify the model, split, score definition and selection criteria. No examples were available when this deck was updated.',
        f'Examples are selected from the validation export: five lowest and five highest scores. Source: {manifest}. Verify provenance in the export; these examples are not aggregate performance.')
    print(f"{model}: embedded ten exported examples")
    return markup[:match.start()] + section + markup[match.end():]


html = (ROOT / "index.html").read_text(encoding="utf-8")
templates = json.loads((ROOT / "specimen_slide_templates.json").read_text(encoding="utf-8"))
for model in ("Guesser", "Referee"):
    pattern = rf'<section class="slide specimen-slide" data-label="{model.upper()} / EXAMPLES".*?</section>'
    html, count = re.subn(pattern, lambda _: templates[model], html, count=1, flags=re.DOTALL)
    if count != 1:
        raise ValueError(f"{model}: example slide missing")
repo = ROOT.parent
html = populate_specimens(html, "Guesser", ROOT / "assets/guesser-specimens.jsonl")
html = populate_specimens(html, "Referee", ROOT / "assets/referee-specimens.jsonl")
(ROOT / "index.html").write_text(html, encoding="utf-8")
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
