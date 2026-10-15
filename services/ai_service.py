"""AI provider layer. Routes never talk to a provider directly; they call get_provider()."""
from __future__ import annotations

import requests

SYSTEM_PROMPT = (
    "You are a helpful, accurate assistant. Answer clearly and concisely. Use Markdown for "
    "structure and fenced code blocks for code. When the user shares an image, base your answer "
    "on what is actually visible in it, and say so if something is unclear."
)
DEFAULT_IMAGE_PROMPT = "Describe this image in detail."


class AIError(Exception):
    """Base error. `status` is the HTTP status the API layer should return."""
    status = 502
    public_message = "The AI service returned an error."

    def __init__(self, message: str | None = None):
        super().__init__(message or self.public_message)


class AIConfigError(AIError):
    status = 503
    public_message = "The AI service is not configured. Set AI_API_KEY and AI_MODEL in your .env file."


class AIVisionUnsupportedError(AIError):
    status = 422
    public_message = ("The configured model does not support images. Set AI_SUPPORTS_VISION=true and "
                      "choose a vision-capable AI_MODEL to analyze images.")


class AIRateLimitError(AIError):
    status = 429
    public_message = "The AI service is rate-limiting requests. Please wait a moment and try again."


class AITimeoutError(AIError):
    status = 504
    public_message = "The AI service took too long to respond. Please try again."


class AIUnavailableError(AIError):
    status = 502
    public_message = "Could not reach the AI service. Check your network connection and try again."


def build_history(messages: list[dict]) -> list[dict]:
    """Turn stored messages into provider-neutral {role, content} text turns.

    Past images are not re-sent (we don't store pixel data); a short note keeps context.
    Roles are merged so they strictly alternate and the list starts with 'user'.
    """
    out: list[dict] = []
    for m in messages:
        text = m["content"]
        if m.get("images"):
            names = ", ".join(i["name"] for i in m["images"])
            text = f"{text}\n[The user attached {len(m['images'])} image(s) here: {names}]".strip()
        if out and out[-1]["role"] == m["role"]:
            out[-1]["content"] += "\n\n" + text
        else:
            out.append({"role": m["role"], "content": text})
    while out and out[0]["role"] != "user":
        out.pop(0)
    return out


class BaseProvider:
    def __init__(self, cfg):
        self.api_key = cfg["AI_API_KEY"]
        self.model = cfg["AI_MODEL"]
        self.base_url = cfg["AI_BASE_URL"]
        self.timeout = cfg["AI_TIMEOUT_SECONDS"]
        self.max_tokens = cfg["AI_MAX_OUTPUT_TOKENS"]
        self.supports_vision = cfg["AI_SUPPORTS_VISION"]

    def check_ready(self, has_images: bool):
        if not self.api_key or not self.model:
            raise AIConfigError()
        if has_images and not self.supports_vision:
            raise AIVisionUnsupportedError()

    def generate(self, history: list[dict], text: str, images: list) -> str:
        self.check_ready(bool(images))
        text = text.strip() or DEFAULT_IMAGE_PROMPT
        return self._call(history, text, images)

    def _call(self, history, text, images) -> str:  # pragma: no cover - interface
        raise NotImplementedError

    def _post(self, url: str, headers: dict, payload: dict) -> dict:
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=self.timeout)
        except requests.Timeout:
            raise AITimeoutError()
        except requests.RequestException:
            raise AIUnavailableError()
        if resp.status_code == 429:
            raise AIRateLimitError()
        if resp.status_code in (401, 403):
            raise AIError("The AI service rejected the API key. Check AI_API_KEY.")
        if resp.status_code >= 400:
            raise AIError(f"The AI service returned an error (HTTP {resp.status_code}).")
        try:
            return resp.json()
        except ValueError:
            raise AIError("The AI service returned an unreadable response.")


class AnthropicProvider(BaseProvider):
    def _call(self, history, text, images):
        url = (self.base_url or "https://api.anthropic.com").rstrip("/") + "/v1/messages"
        content = [{"type": "image",
                    "source": {"type": "base64", "media_type": i.media_type, "data": i.b64}}
                   for i in images]
        content.append({"type": "text", "text": text})
        payload = {"model": self.model, "max_tokens": self.max_tokens, "system": SYSTEM_PROMPT,
                   "messages": history + [{"role": "user", "content": content}]}
        headers = {"x-api-key": self.api_key, "anthropic-version": "2023-06-01",
                   "content-type": "application/json"}
        data = self._post(url, headers, payload)
        reply = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
        if not reply.strip():
            raise AIError("The AI service returned an empty response.")
        return reply.strip()


class OpenAICompatibleProvider(BaseProvider):
    def _call(self, history, text, images):
        url = (self.base_url or "https://api.openai.com/v1").rstrip("/") + "/chat/completions"
        content = [{"type": "text", "text": text}]
        content += [{"type": "image_url",
                     "image_url": {"url": f"data:{i.media_type};base64,{i.b64}"}} for i in images]
        user_msg = {"role": "user", "content": content if images else text}
        payload = {"model": self.model, "max_tokens": self.max_tokens,
                   "messages": [{"role": "system", "content": SYSTEM_PROMPT}] + history + [user_msg]}
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        data = self._post(url, headers, payload)
        try:
            reply = data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError):
            raise AIError("The AI service returned an unexpected response.")
        if not reply.strip():
            raise AIError("The AI service returned an empty response.")
        return reply.strip()


PROVIDERS = {"anthropic": AnthropicProvider, "openai": OpenAICompatibleProvider}


def get_provider(cfg) -> BaseProvider:
    cls = PROVIDERS.get(cfg["AI_PROVIDER"])
    if cls is None:
        raise AIConfigError(f"Unknown AI_PROVIDER '{cfg['AI_PROVIDER']}'. Use: {', '.join(PROVIDERS)}.")
    return cls(cfg)
