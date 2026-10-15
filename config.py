"""Application configuration, read from environment variables."""
import os
from dotenv import load_dotenv

load_dotenv()


def _bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "dev-only-insecure-key")
    DATABASE = os.getenv("DATABASE_PATH", os.path.join("instance", "chat.db"))

    # Session / cookie hardening
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = _bool("SESSION_COOKIE_SECURE", False)
    PERMANENT_SESSION_LIFETIME = 60 * 60 * 24 * 30  # 30 days

    # AI provider
    AI_PROVIDER = os.getenv("AI_PROVIDER", "anthropic").lower()
    AI_API_KEY = os.getenv("AI_API_KEY", "")
    AI_MODEL = os.getenv("AI_MODEL", "")
    AI_BASE_URL = os.getenv("AI_BASE_URL", "")
    AI_TIMEOUT_SECONDS = int(os.getenv("AI_TIMEOUT_SECONDS", "60"))
    AI_MAX_OUTPUT_TOKENS = int(os.getenv("AI_MAX_OUTPUT_TOKENS", "1024"))
    AI_SUPPORTS_VISION = _bool("AI_SUPPORTS_VISION", True)

    # Limits
    MAX_MESSAGE_CHARS = int(os.getenv("MAX_MESSAGE_CHARS", "4000"))
    MAX_IMAGES_PER_REQUEST = int(os.getenv("MAX_IMAGES_PER_REQUEST", "4"))
    MAX_IMAGE_MB = int(os.getenv("MAX_IMAGE_MB", "5"))
    HISTORY_MESSAGE_LIMIT = int(os.getenv("HISTORY_MESSAGE_LIMIT", "20"))
    MAX_CONTENT_LENGTH = (MAX_IMAGE_MB * MAX_IMAGES_PER_REQUEST + 1) * 1024 * 1024


class TestConfig(Config):
    TESTING = True
    SECRET_KEY = "test-secret"
    DATABASE = ":memory:"
    AI_PROVIDER = "anthropic"
    AI_API_KEY = "test-key"
    AI_MODEL = "test-model"
