"""Synthetic evidence for integration tests."""

from PIL import Image


class RefereeFixture:
    def predict(self, image: Image.Image) -> dict:
        red, green, _ = image.getpixel((0, 0))
        return {"status": "evidence", "scores": [red / 255, green / 255]}
