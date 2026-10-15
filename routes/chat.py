import logging

from flask import Blueprint, current_app, jsonify, request

from models import db
from security import current_owner
from services import ai_service
from services.image_service import ImageValidationError, validate_uploads

bp = Blueprint("chat", __name__)
log = logging.getLogger(__name__)


def _json_error(message: str, status: int):
    return jsonify({"error": message}), status


def _parse_request():
    """Accepts multipart/form-data (text + images) or JSON (text only)."""
    if request.is_json:
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise ValueError("Request body must be a JSON object.")
        return data.get("message", ""), data.get("conversation_id"), []
    return (request.form.get("message", ""), request.form.get("conversation_id") or None,
            request.files.getlist("images"))


@bp.post("/api/chat")
def chat():
    cfg = current_app.config
    owner = current_owner()

    try:
        message, conversation_id, files = _parse_request()
    except ValueError as exc:
        return _json_error(str(exc), 400)

    if not isinstance(message, str):
        return _json_error("'message' must be text.", 400)
    message = message.strip()
    if len(message) > cfg["MAX_MESSAGE_CHARS"]:
        return _json_error(f"Message is too long (max {cfg['MAX_MESSAGE_CHARS']} characters).", 413)

    try:
        images = validate_uploads(files, cfg["MAX_IMAGES_PER_REQUEST"], cfg["MAX_IMAGE_MB"] * 1024 * 1024)
    except ImageValidationError as exc:
        return _json_error(str(exc), exc.status)

    if not message and not images:
        return _json_error("Please enter a message or attach an image.", 400)

    history = []
    if conversation_id:
        if not isinstance(conversation_id, str) or not db.get_conversation(owner, conversation_id):
            return _json_error("Conversation not found.", 404)
        history = ai_service.build_history(
            db.get_recent_messages(conversation_id, cfg["HISTORY_MESSAGE_LIMIT"]))

    try:
        provider = ai_service.get_provider(cfg)
        reply = provider.generate(history, message, images)
    except ai_service.AIError as exc:
        log.warning("AI request failed: %s", type(exc).__name__)  # never log content or keys
        return _json_error(str(exc), exc.status)

    # Persist only after a successful AI response so failed sends leave no half-saved turns.
    if not conversation_id:
        conversation_id = db.create_conversation(owner, db.make_title(message))
    user_msg = db.add_message(conversation_id, "user", message, [i.meta() for i in images])
    assistant_msg = db.add_message(conversation_id, "assistant", reply)
    conv = db.get_conversation(owner, conversation_id)

    return jsonify({"conversation_id": conversation_id, "title": conv["title"],
                    "user_message": user_msg, "message": assistant_msg})
