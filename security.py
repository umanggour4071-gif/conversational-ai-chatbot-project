"""Session-based identity, CSRF protection and security headers."""
import hmac
import secrets
import uuid

from flask import abort, request, session


def current_owner() -> str:
    """Anonymous per-browser identity stored in the signed session cookie."""
    if "owner_id" not in session:
        session["owner_id"] = uuid.uuid4().hex
        session.permanent = True
    return session["owner_id"]


def csrf_token() -> str:
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(32)
    return session["csrf"]


def csrf_protect():
    """Reject unsafe-method requests without a matching X-CSRFToken header."""
    if request.method in ("POST", "PATCH", "PUT", "DELETE") and request.path.startswith("/api/"):
        sent = request.headers.get("X-CSRFToken", "")
        expected = session.get("csrf", "")
        if not expected or not hmac.compare_digest(sent, expected):
            abort(400, description="Missing or invalid CSRF token. Refresh the page and try again.")


def add_security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    resp.headers.setdefault("Permissions-Policy", "microphone=(self), camera=()")
    # Every script, style and font is served from /static (vendored), so nothing external is allowed.
    resp.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; "
        "img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; "
        "base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    )
    if request_is_api():
        resp.headers["Cache-Control"] = "no-store"
    return resp


def request_is_api() -> bool:
    return request.path.startswith("/api/")
