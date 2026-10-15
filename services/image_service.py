"""Image validation. Verifies real content (not just extension) and never writes to disk."""
import base64
import io
from dataclasses import dataclass

from PIL import Image, UnidentifiedImageError

ALLOWED_FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}
MAX_PIXELS = 40_000_000  # decompression-bomb guard


class ImageValidationError(ValueError):
    """Raised with a user-safe message when an upload is rejected."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


@dataclass
class ValidatedImage:
    name: str
    media_type: str
    size: int
    width: int
    height: int
    b64: str

    def meta(self) -> dict:
        """Metadata that is safe to persist (no pixel data)."""
        return {"name": self.name, "type": self.media_type, "size": self.size,
                "width": self.width, "height": self.height}


def _safe_name(name: str) -> str:
    name = (name or "image").replace("\\", "/").split("/")[-1]
    return "".join(c for c in name if c.isprintable())[:80] or "image"


def validate_image(data: bytes, filename: str, max_bytes: int) -> ValidatedImage:
    name = _safe_name(filename)
    if not data:
        raise ImageValidationError(f"'{name}' is empty.")
    if len(data) > max_bytes:
        raise ImageValidationError(
            f"'{name}' is larger than the {max_bytes // (1024 * 1024)} MB limit.", 413)

    try:
        with Image.open(io.BytesIO(data)) as img:
            fmt = img.format
            width, height = img.size
            if fmt not in ALLOWED_FORMATS:
                raise ImageValidationError(
                    f"'{name}' is not a supported image. Use JPEG, PNG or WebP.", 415)
            if width * height > MAX_PIXELS:
                raise ImageValidationError(f"'{name}' has too many pixels.", 413)
            img.verify()  # detects truncated / corrupted files
    except ImageValidationError:
        raise
    except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError):
        raise ImageValidationError(f"'{name}' is not a valid or readable image.", 415)

    return ValidatedImage(name=name, media_type=ALLOWED_FORMATS[fmt], size=len(data),
                          width=width, height=height,
                          b64=base64.b64encode(data).decode("ascii"))


def validate_uploads(files, max_images: int, max_bytes: int):
    files = [f for f in files if f and f.filename]
    if len(files) > max_images:
        raise ImageValidationError(f"You can attach at most {max_images} images per message.")
    return [validate_image(f.read(max_bytes + 1), f.filename, max_bytes) for f in files]
