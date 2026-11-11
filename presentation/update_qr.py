"""Regenerate the functional QR asset from the public game URL in config.js."""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "private" / "python"))
import qrcode

match = re.search(r"gameUrl:\s*'([^']+)'", (ROOT / "config.js").read_text())
if match is None or not match[1].startswith(("https://", "http://")):
    raise ValueError("Set a public HTTP(S) gameUrl in config.js first")
qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=16, border=4)
qr.add_data(match[1])
qr.make(fit=True)
qr.make_image(fill_color="black", back_color="white").save(ROOT / "assets" / "game-qr.png")
print(f"QR generated for {match[1]}")
