"""Frontend integration tests that need only Python: template, static assets, CSP, and JS<->HTML wiring."""
import re
import unittest
from pathlib import Path

from tests.test_app import Base

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
JS_FILES = sorted((STATIC / "js").glob("*.js"))


class PageTests(Base):
    def setUp(self):
        super().setUp()
        self.html = self.client.get("/").get_data(as_text=True)

    def test_renders_with_csrf_token_and_limits_from_config(self):
        self.assertIn(f'content="{self.token}"', self.html)
        cfg = self.app.config
        self.assertIn(f'data-max-images="{cfg["MAX_IMAGES_PER_REQUEST"]}"', self.html)
        self.assertIn(f'data-max-image-mb="{cfg["MAX_IMAGE_MB"]}"', self.html)
        self.assertIn(f'data-max-chars="{cfg["MAX_MESSAGE_CHARS"]}"', self.html)

    def test_limits_follow_overrides(self):
        self.app.config.update(MAX_IMAGES_PER_REQUEST=2, MAX_IMAGE_MB=3, MAX_MESSAGE_CHARS=500)
        html = self.client.get("/").get_data(as_text=True)
        self.assertIn('data-max-images="2"', html)
        self.assertIn('data-max-image-mb="3"', html)
        self.assertIn('data-max-chars="500"', html)

    def test_every_asset_referenced_by_the_page_is_served(self):
        urls = re.findall(r'(?:src|href)="(/static/[^"]+)"', self.html)
        self.assertTrue(urls)
        for url in urls:
            r = self.client.get(url)
            self.assertEqual(r.status_code, 200, url)
        self.assertIn("javascript", self.client.get("/static/js/main.js").content_type)
        self.assertIn("text/css", self.client.get("/static/css/styles.css").content_type)

    def test_every_js_module_and_font_is_served(self):
        for path in [*JS_FILES, *(STATIC / "fonts").glob("*.woff2"), *(STATIC / "vendor").glob("*.js")]:
            rel = path.relative_to(ROOT).as_posix()
            self.assertEqual(self.client.get("/" + rel).status_code, 200, rel)

    def test_csp_allows_only_self_hosted_resources(self):
        csp = self.client.get("/").headers["Content-Security-Policy"]
        self.assertIn("script-src 'self'", csp)
        self.assertNotRegex(csp, r"https?://")
        self.assertNotIn("unsafe-inline", csp)
        self.assertNotIn("unsafe-eval", csp)
        self.assertIn("img-src 'self' data: blob:", csp)  # image previews use blob: URLs
        self.assertIn("microphone=(self)", self.client.get("/").headers["Permissions-Policy"])

    def test_page_has_no_inline_script_or_style_that_the_csp_would_block(self):
        self.assertEqual(re.findall(r"<script(?![^>]*\bsrc=)[^>]*>", self.html), [])
        self.assertNotRegex(self.html, r'\sstyle="')
        self.assertNotRegex(self.html, r'\son[a-z]+="')
        css = (STATIC / "css" / "styles.css").read_text()
        self.assertNotRegex(css, r"https?://")

    def test_no_external_hosts_in_page_or_scripts(self):
        self.assertNotRegex(self.html, r'(?:src|href)="https?://')
        for path in JS_FILES:
            self.assertNotRegex(path.read_text(), r"""fetch\(\s*["'`]https?://""", path.name)

    def test_every_element_id_used_by_javascript_exists_in_the_template(self):
        html_ids = set(re.findall(r'\sid="([^"]+)"', self.html))
        used = set()
        for path in JS_FILES:
            src = path.read_text()
            used |= set(re.findall(r'getElementById\(\s*"([^"]+)"', src))
            used |= set(re.findall(r'\$\(\s*"([^"]+)"\s*\)', src))
        self.assertTrue(used, "no ids found - the regex is broken")
        self.assertEqual(sorted(used - html_ids), [])

    def test_icons_used_anywhere_are_defined_in_the_sprite(self):
        defined = set(re.findall(r'<symbol id="i-([\w-]+)"', self.html))
        page = re.sub(r"<!--.*?-->", "", self.html, flags=re.S)  # ignore comments
        used = set(re.findall(r'href="#i-([\w-]+)"', page))
        for path in JS_FILES:
            src = re.sub(r"/\*.*?\*/", "", path.read_text(), flags=re.S)  # block comments
            src = re.sub(r"^\s*//.*$", "", src, flags=re.M)  # line comments
            used |= set(re.findall(r'icon\(\s*doc\s*,\s*"([\w-]+)"', src))
            used |= set(re.findall(r'setIcon\([^,]+,\s*"([\w-]+)"', src))
        # icons chosen at runtime via ternaries / setIcon()
        used |= {"check", "copy", "stop", "speaker"}
        self.assertEqual(sorted(used - defined), [])

    def test_js_relative_imports_resolve(self):
        for path in JS_FILES:
            for target in re.findall(r'from\s+"(\./[^"]+)"', path.read_text()):
                self.assertTrue((path.parent / target).exists(), f"{path.name} imports missing {target}")

    def test_accessibility_landmarks_and_labels(self):
        self.assertIn('lang="en"', self.html)
        self.assertRegex(self.html, r'<label class="sr-only" for="message-input">')
        for control in ("attach-btn", "mic-btn", "send-btn", "menu-btn", "sidebar-close-btn"):
            self.assertRegex(self.html, rf'id="{control}"[^>]*aria-label="[^"]+"', control)
        self.assertIn('id="composer-status" role="status" aria-live="polite"', self.html)
        self.assertIn('accept="image/jpeg,image/png,image/webp"', self.html)

    def test_vendored_libraries_are_present_and_credited(self):
        for name in ("marked.umd.js", "purify.min.js", "README.md"):
            self.assertTrue((STATIC / "vendor" / name).exists(), name)

    def test_part1_api_unchanged_by_the_frontend(self):
        # The frontend posts multipart form data even for text-only messages; make sure that works.
        from unittest.mock import patch
        from tests.test_app import OK_REPLY, fake_response
        with patch("services.ai_service.requests.post", return_value=fake_response(200, OK_REPLY)):
            r = self.post_chat(data={"message": "hello from the form"}, content_type="multipart/form-data")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["message"]["content"], "Hello from the model")


if __name__ == "__main__":
    unittest.main()
