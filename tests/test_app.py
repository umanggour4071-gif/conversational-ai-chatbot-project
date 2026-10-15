import io
import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import requests
from PIL import Image

from app import create_app
from config import TestConfig


def make_image(fmt="PNG", size=(20, 20)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, "red").save(buf, fmt)
    return buf.getvalue()


def fake_response(status=200, json_data=None):
    r = MagicMock()
    r.status_code = status
    r.json.return_value = json_data if json_data is not None else {}
    return r


OK_REPLY = {"content": [{"type": "text", "text": "Hello from the model"}]}


class Base(unittest.TestCase):
    config_overrides = {}

    def setUp(self):
        fd, self.db_path = tempfile.mkstemp(suffix=".db")
        os.close(fd)

        class Cfg(TestConfig):
            DATABASE = self.db_path

        for k, v in self.config_overrides.items():
            setattr(Cfg, k, v)
        self.app = create_app(Cfg)
        self.client = self.app.test_client()
        self.token = self._token(self.client)

    def tearDown(self):
        os.unlink(self.db_path)

    def _token(self, client):
        client.get("/")
        with client.session_transaction() as s:
            return s["csrf"]

    def post_chat(self, client=None, token=None, **kw):
        client = client or self.client
        return client.post("/api/chat", headers={"X-CSRFToken": token or self.token}, **kw)

    def chat_text(self, text="hi", client=None, token=None, conversation_id=None):
        body = {"message": text}
        if conversation_id:
            body["conversation_id"] = conversation_id
        return self.post_chat(client=client, token=token, json=body)


class HomepageTests(Base):
    def test_homepage_renders_with_csrf_and_headers(self):
        r = self.client.get("/")
        self.assertEqual(r.status_code, 200)
        self.assertIn(b'name="csrf-token"', r.data)
        self.assertEqual(r.headers["X-Content-Type-Options"], "nosniff")
        self.assertIn("Content-Security-Policy", r.headers)


class ChatValidationTests(Base):
    def test_missing_csrf_rejected(self):
        r = self.client.post("/api/chat", json={"message": "hi"})
        self.assertEqual(r.status_code, 400)

    def test_empty_message_rejected(self):
        self.assertEqual(self.chat_text("   ").status_code, 400)

    def test_non_string_message_rejected(self):
        self.assertEqual(self.post_chat(json={"message": 123}).status_code, 400)

    def test_invalid_json_body_rejected(self):
        self.assertEqual(self.post_chat(json=["x"]).status_code, 400)

    def test_message_too_long(self):
        r = self.chat_text("a" * (self.app.config["MAX_MESSAGE_CHARS"] + 1))
        self.assertEqual(r.status_code, 413)

    def test_unknown_conversation_404(self):
        self.assertEqual(self.chat_text("hi", conversation_id="nope").status_code, 404)


class ImageValidationTests(Base):
    def send_image(self, data, name="a.png", message="what is this?"):
        return self.post_chat(data={"message": message, "images": (io.BytesIO(data), name)},
                              content_type="multipart/form-data")

    def test_unsupported_format(self):
        r = self.send_image(make_image("GIF"), "a.gif")
        self.assertEqual(r.status_code, 415)

    def test_fake_extension_text_file(self):
        r = self.send_image(b"<?php echo 1; ?>", "evil.png")
        self.assertEqual(r.status_code, 415)

    def test_corrupted_image(self):
        r = self.send_image(make_image("PNG")[:40], "broken.png")
        self.assertEqual(r.status_code, 415)

    def test_oversized_image(self):
        with patch.dict(self.app.config, {"MAX_IMAGE_MB": 0}):
            r = self.send_image(make_image())
        self.assertEqual(r.status_code, 413)

    def test_too_many_images(self):
        files = [(io.BytesIO(make_image()), f"{i}.png") for i in range(5)]
        r = self.post_chat(data={"message": "x", "images": files}, content_type="multipart/form-data")
        self.assertEqual(r.status_code, 400)

    @patch("services.ai_service.requests.post")
    def test_valid_image_sent_to_model_and_metadata_saved(self, post):
        post.return_value = fake_response(200, OK_REPLY)
        r = self.send_image(make_image("WEBP"), "pic.webp")
        self.assertEqual(r.status_code, 200)
        sent = post.call_args.kwargs["json"]["messages"][-1]["content"]
        self.assertEqual(sent[0]["type"], "image")
        self.assertEqual(sent[0]["source"]["media_type"], "image/webp")
        meta = r.get_json()["user_message"]["images"][0]
        self.assertEqual(meta["name"], "pic.webp")
        self.assertNotIn("b64", meta)

    @patch("services.ai_service.requests.post")
    def test_image_only_message_uses_default_prompt(self, post):
        post.return_value = fake_response(200, OK_REPLY)
        r = self.send_image(make_image(), message="")
        self.assertEqual(r.status_code, 200)
        self.assertIn("Describe", post.call_args.kwargs["json"]["messages"][-1]["content"][-1]["text"])

    @patch("services.ai_service.requests.post")
    def test_vision_disabled_gives_clear_error(self, post):
        with patch.dict(self.app.config, {"AI_SUPPORTS_VISION": False}):
            r = self.send_image(make_image())
        self.assertEqual(r.status_code, 422)
        self.assertIn("vision", r.get_json()["error"].lower())
        post.assert_not_called()


class AIServiceTests(Base):
    @patch("services.ai_service.requests.post")
    def test_success_creates_conversation_with_title(self, post):
        post.return_value = fake_response(200, OK_REPLY)
        r = self.chat_text("Explain recursion please")
        body = r.get_json()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(body["message"]["content"], "Hello from the model")
        self.assertEqual(body["title"], "Explain recursion please")

    def test_missing_api_config(self):
        with patch.dict(self.app.config, {"AI_API_KEY": ""}):
            r = self.chat_text("hi")
        self.assertEqual(r.status_code, 503)
        self.assertIn("not configured", r.get_json()["error"])

    @patch("services.ai_service.requests.post", side_effect=requests.Timeout)
    def test_timeout(self, _):
        self.assertEqual(self.chat_text().status_code, 504)

    @patch("services.ai_service.requests.post", side_effect=requests.ConnectionError)
    def test_network_failure(self, _):
        self.assertEqual(self.chat_text().status_code, 502)

    @patch("services.ai_service.requests.post")
    def test_rate_limit(self, post):
        post.return_value = fake_response(429)
        self.assertEqual(self.chat_text().status_code, 429)

    @patch("services.ai_service.requests.post")
    def test_provider_500_and_bad_key(self, post):
        post.return_value = fake_response(500)
        self.assertEqual(self.chat_text().status_code, 502)
        post.return_value = fake_response(401)
        self.assertIn("API key", self.chat_text().get_json()["error"])

    @patch("services.ai_service.requests.post")
    def test_failed_ai_call_saves_nothing(self, post):
        post.return_value = fake_response(500)
        self.chat_text("hello")
        self.assertEqual(self.client.get("/api/conversations").get_json()["conversations"], [])

    @patch("services.ai_service.requests.post")
    def test_history_sent_for_followups(self, post):
        post.return_value = fake_response(200, OK_REPLY)
        cid = self.chat_text("first question").get_json()["conversation_id"]
        self.chat_text("and a follow-up", conversation_id=cid)
        msgs = post.call_args.kwargs["json"]["messages"]
        self.assertEqual([m["role"] for m in msgs], ["user", "assistant", "user"])
        self.assertEqual(msgs[0]["content"], "first question")

    @patch("services.ai_service.requests.post")
    def test_openai_compatible_provider(self, post):
        post.return_value = fake_response(200, {"choices": [{"message": {"content": "hi there"}}]})
        with patch.dict(self.app.config, {"AI_PROVIDER": "openai"}):
            r = self.chat_text("hello")
        self.assertEqual(r.get_json()["message"]["content"], "hi there")
        self.assertIn("/chat/completions", post.call_args.args[0])

    def test_unknown_provider(self):
        with patch.dict(self.app.config, {"AI_PROVIDER": "nope"}):
            self.assertEqual(self.chat_text().status_code, 503)


@patch("services.ai_service.requests.post")
class ConversationTests(Base):
    def make_conv(self, post, text="hello world"):
        post.return_value = fake_response(200, OK_REPLY)
        return self.chat_text(text).get_json()["conversation_id"]

    def test_list_get_rename_delete(self, post):
        cid = self.make_conv(post)
        listing = self.client.get("/api/conversations").get_json()["conversations"]
        self.assertEqual([c["id"] for c in listing], [cid])

        got = self.client.get(f"/api/conversations/{cid}").get_json()
        self.assertEqual([m["role"] for m in got["messages"]], ["user", "assistant"])

        h = {"X-CSRFToken": self.token}
        r = self.client.patch(f"/api/conversations/{cid}", json={"title": "  New   name "}, headers=h)
        self.assertEqual(r.get_json()["title"], "New name")
        self.assertEqual(self.client.patch(f"/api/conversations/{cid}", json={"title": ""}, headers=h).status_code, 400)
        self.assertEqual(self.client.patch(f"/api/conversations/{cid}", json={"title": "x" * 101}, headers=h).status_code, 400)

        self.assertEqual(self.client.delete(f"/api/conversations/{cid}", headers=h).status_code, 200)
        self.assertEqual(self.client.get(f"/api/conversations/{cid}").status_code, 404)

    def test_long_title_truncated(self, post):
        cid = self.make_conv(post, "word " * 40)
        title = self.client.get(f"/api/conversations/{cid}").get_json()["title"]
        self.assertLessEqual(len(title), 48)
        self.assertTrue(title.endswith("…"))

    def test_other_users_cannot_access(self, post):
        cid = self.make_conv(post)
        other = self.app.test_client()
        tok = self._token(other)
        h = {"X-CSRFToken": tok}
        self.assertEqual(other.get(f"/api/conversations/{cid}").status_code, 404)
        self.assertEqual(other.patch(f"/api/conversations/{cid}", json={"title": "hax"}, headers=h).status_code, 404)
        self.assertEqual(other.delete(f"/api/conversations/{cid}", headers=h).status_code, 404)
        self.assertEqual(self.chat_text("hi", client=other, token=tok, conversation_id=cid).status_code, 404)
        self.assertEqual(other.get("/api/conversations").get_json()["conversations"], [])
        self.assertEqual(self.client.get(f"/api/conversations/{cid}").status_code, 200)


if __name__ == "__main__":
    unittest.main()
