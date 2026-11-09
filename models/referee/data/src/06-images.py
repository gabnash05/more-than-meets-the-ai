"""The shared Guesser foreground view, without additional transforms."""

from PIL import Image


def preprocess(image: Image.Image) -> dict:
    from guesser_data import preprocess as guesser_preprocess

    return guesser_preprocess(image, candidate="foreground")
