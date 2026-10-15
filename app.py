"""Application factory."""
import logging

from flask import Flask, jsonify, request
from werkzeug.exceptions import HTTPException

from config import Config
from models import db
from routes import chat, conversations, main
from security import add_security_headers, csrf_protect


def create_app(config_object=Config) -> Flask:
    app = Flask(__name__)
    app.config.from_object(config_object)
    logging.basicConfig(level=logging.INFO)

    if not app.config.get("TESTING") and app.config["SECRET_KEY"] == "dev-only-insecure-key":
        app.logger.warning("SECRET_KEY is not set; using an insecure development key.")

    app.teardown_appcontext(db.close_db)
    with app.app_context():
        db.init_db()

    app.before_request(csrf_protect)
    app.after_request(add_security_headers)
    for module in (main, chat, conversations):
        app.register_blueprint(module.bp)

    @app.errorhandler(HTTPException)
    def http_error(exc):
        if request.path.startswith("/api/"):
            message = exc.description
            if exc.code == 413:
                message = "The upload is too large."
            return jsonify({"error": message}), exc.code
        return exc

    @app.errorhandler(Exception)
    def unexpected(exc):
        app.logger.exception("Unhandled error")
        if request.path.startswith("/api/"):
            return jsonify({"error": "Something went wrong on the server."}), 500
        return "Internal server error", 500

    return app


if __name__ == "__main__":
    create_app().run(debug=False, host="127.0.0.1", port=5000)
