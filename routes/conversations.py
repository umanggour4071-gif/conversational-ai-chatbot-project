from flask import Blueprint, jsonify, request

from models import db
from security import current_owner

bp = Blueprint("conversations", __name__)

MAX_TITLE = 100


def _not_found():
    return jsonify({"error": "Conversation not found."}), 404


@bp.get("/api/conversations")
def list_all():
    return jsonify({"conversations": db.list_conversations(current_owner())})


@bp.get("/api/conversations/<conversation_id>")
def get_one(conversation_id):
    conv = db.get_conversation(current_owner(), conversation_id)
    if not conv:
        return _not_found()
    conv["messages"] = db.get_messages(conversation_id)
    return jsonify(conv)


@bp.patch("/api/conversations/<conversation_id>")
def rename(conversation_id):
    data = request.get_json(silent=True)
    title = data.get("title") if isinstance(data, dict) else None
    if not isinstance(title, str) or not title.strip():
        return jsonify({"error": "A non-empty 'title' is required."}), 400
    title = " ".join(title.split())
    if len(title) > MAX_TITLE:
        return jsonify({"error": f"Title must be at most {MAX_TITLE} characters."}), 400
    if not db.rename_conversation(current_owner(), conversation_id, title):
        return _not_found()
    return jsonify({"id": conversation_id, "title": title})


@bp.delete("/api/conversations/<conversation_id>")
def delete(conversation_id):
    if not db.delete_conversation(current_owner(), conversation_id):
        return _not_found()
    return jsonify({"deleted": True})
