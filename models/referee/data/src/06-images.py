"""Shared Guesser foreground preprocessing with canvas-safe decoding."""

from PIL import Image, ImageOps

FOREGROUND_OVERRIDES = {"working_size": 1024, "distance": 0.04}


def preprocessing_config() -> dict:
    from guesser_data.common import load_step

    return {
        "version": "referee-foreground-v1",
        "orientation": "exif-transpose",
        "alpha": "composite-white",
        "foreground": load_step("06-images").candidate_config("foreground", FOREGROUND_OVERRIDES),
    }


def preprocessing_hash() -> str:
    from .common import object_hash

    return object_hash(preprocessing_config())


def preprocess(image: Image.Image) -> dict:
    from guesser_data import preprocess as guesser_preprocess

    image = ImageOps.exif_transpose(image).convert("RGBA")
    background = Image.new("RGBA", image.size, "white")
    background.alpha_composite(image)
    result = guesser_preprocess(
        background.convert("RGB"), candidate="foreground", config=FOREGROUND_OVERRIDES
    )
    result["diagnostics"]["config_hash"] = preprocessing_hash()
    return result
