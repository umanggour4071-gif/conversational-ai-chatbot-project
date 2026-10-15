from flask import Blueprint, current_app, render_template

from security import csrf_token

bp = Blueprint("main", __name__)


@bp.get("/")
def index():
    cfg = current_app.config
    # The frontend reads these so its client-side checks always match the server's limits.
    limits = {
        "max_images": cfg["MAX_IMAGES_PER_REQUEST"],
        "max_image_mb": cfg["MAX_IMAGE_MB"],
        "max_chars": cfg["MAX_MESSAGE_CHARS"],
    }
    return render_template("index.html", csrf_token=csrf_token(), limits=limits)


@bp.get("/api/health")
def health():
    return {"status": "ok"}
