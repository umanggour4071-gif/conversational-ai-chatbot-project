"""SQLite data layer. Every query that touches a conversation is scoped by owner_id."""
import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone

from flask import current_app, g

SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_owner ON conversations(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    images_meta TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        path = current_app.config["DATABASE"]
        if path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        g.db = sqlite3.connect(path)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


def close_db(_exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    get_db().executescript(SCHEMA)
    get_db().commit()


def make_title(text: str, limit: int = 48) -> str:
    text = " ".join((text or "").split())
    if not text:
        return "Image conversation"
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


# ---- conversations -------------------------------------------------------

def create_conversation(owner_id: str, title: str) -> str:
    cid = uuid.uuid4().hex
    ts = now()
    get_db().execute(
        "INSERT INTO conversations (id, owner_id, title, created_at, updated_at) VALUES (?,?,?,?,?)",
        (cid, owner_id, title, ts, ts),
    )
    get_db().commit()
    return cid


def list_conversations(owner_id: str):
    rows = get_db().execute(
        "SELECT id, title, created_at, updated_at FROM conversations "
        "WHERE owner_id = ? ORDER BY updated_at DESC, rowid DESC",
        (owner_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def get_conversation(owner_id: str, conversation_id: str):
    """Returns the conversation dict, or None if missing OR owned by someone else."""
    row = get_db().execute(
        "SELECT id, title, created_at, updated_at FROM conversations WHERE id = ? AND owner_id = ?",
        (conversation_id, owner_id),
    ).fetchone()
    return dict(row) if row else None


def rename_conversation(owner_id: str, conversation_id: str, title: str) -> bool:
    cur = get_db().execute(
        "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND owner_id = ?",
        (title, now(), conversation_id, owner_id),
    )
    get_db().commit()
    return cur.rowcount > 0


def delete_conversation(owner_id: str, conversation_id: str) -> bool:
    cur = get_db().execute(
        "DELETE FROM conversations WHERE id = ? AND owner_id = ?", (conversation_id, owner_id)
    )
    get_db().commit()
    return cur.rowcount > 0


# ---- messages ------------------------------------------------------------

def add_message(conversation_id: str, role: str, content: str, images_meta=None) -> dict:
    ts = now()
    meta = json.dumps(images_meta or [])
    db = get_db()
    cur = db.execute(
        "INSERT INTO messages (conversation_id, role, content, images_meta, created_at) VALUES (?,?,?,?,?)",
        (conversation_id, role, content, meta, ts),
    )
    db.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (ts, conversation_id))
    db.commit()
    return {"id": cur.lastrowid, "role": role, "content": content,
            "images": images_meta or [], "created_at": ts}


def _row_to_message(r) -> dict:
    return {"id": r["id"], "role": r["role"], "content": r["content"],
            "images": json.loads(r["images_meta"]), "created_at": r["created_at"]}


def get_messages(conversation_id: str):
    rows = get_db().execute(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC", (conversation_id,)
    ).fetchall()
    return [_row_to_message(r) for r in rows]


def get_recent_messages(conversation_id: str, limit: int):
    rows = get_db().execute(
        "SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) "
        "ORDER BY id ASC",
        (conversation_id, limit),
    ).fetchall()
    return [_row_to_message(r) for r in rows]
