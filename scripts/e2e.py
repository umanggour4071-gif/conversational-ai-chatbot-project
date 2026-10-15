"""Real-browser end-to-end check of the whole app, plus README screenshots.

Starts the real Flask app against scripts/mock_model_server.py (a local stand-in for the AI API) and
drives the UI with Playwright + Chromium. Headless browsers have no microphone or voices, so fake
SpeechRecognition / speechSynthesis objects are injected for the voice tests.

Setup (once):   pip install -r requirements-dev.txt && playwright install chromium
Run checks:     python scripts/e2e.py
Screenshots:    python scripts/e2e.py --screenshots docs/screenshots
Own Chromium:   CHROMIUM_PATH=/path/to/chromium python scripts/e2e.py
"""
from __future__ import annotations

import argparse
import base64
import io
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import mock_model_server  # noqa: E402

FAILURES: list[str] = []


def check(name: str, condition, detail: str = ""):
    print(("  ok   " if condition else "  FAIL ") + name + ("" if condition else f"  {detail}"))
    if not condition:
        FAILURES.append(name)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ---- test assets ------------------------------------------------------------------------------

def png_bytes(size=(64, 48), color="red", fancy=False) -> bytes:
    img = Image.new("RGB", size, color)
    if fancy:  # a gradient with a disc, so screenshots show something real
        px = img.load()
        for x in range(size[0]):
            for y in range(size[1]):
                px[x, y] = (30 + int(200 * x / size[0]), 90 + int(90 * y / size[1]), 160 - int(100 * x / size[0]))
        ImageDraw.Draw(img).ellipse((size[0] * .55, size[1] * .15, size[0] * .85, size[1] * .55), fill=(255, 214, 120))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def make_assets(folder: Path) -> dict[str, Path]:
    files = {
        "red.png": png_bytes(),
        "photo.png": png_bytes((640, 420), fancy=True),
        "anim.gif": b"GIF89a" + b"\x01\x00\x01\x00\x00\x00\x00;",
        "fake.png": b"this is not really an image",
        "big.png": b"\x89PNG\r\n\x1a\n" + os.urandom(6 * 1024 * 1024),
        "notes.txt": b"hello",
    }
    paths = {}
    for name, data in files.items():
        (folder / name).write_bytes(data)
        paths[name] = folder / name
    return paths


# ---- fake browser speech APIs ------------------------------------------------------------------

INIT_SCRIPT = """
(() => {
  window.__speech = { spoken: [], cancelled: 0 };
  const synth = {
    speaking: false, pending: false, paused: false, _u: null,
    getVoices() { return []; },
    speak(u) { this.speaking = true; this._u = u; window.__speech.spoken.push(u.text); },
    cancel() { this.speaking = false; this._u = null; window.__speech.cancelled++; },
    resume() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = function (text) { this.text = text; };
  window.__finishUtterance = () => { const u = synth._u; synth.speaking = false; synth._u = null; if (u && u.onend) u.onend({}); };

  class FakeSR {
    constructor() { window.__sr = this; }
    start() {
      if (window.__srMode === 'deny') {
        setTimeout(() => { this.onerror && this.onerror({ error: 'not-allowed' }); this.onend && this.onend(); }, 10);
        return;
      }
      setTimeout(() => this.onstart && this.onstart(), 10);
    }
    stop() { setTimeout(() => this.onend && this.onend(), 10); }
    abort() { this.onend && this.onend(); }
  }
  window.SpeechRecognition = FakeSR;
  window.webkitSpeechRecognition = FakeSR;
  window.__emit = (parts, resultIndex) => {
    const results = parts.map((p) => { const r = [{ transcript: p.t }]; r.isFinal = p.final; return r; });
    window.__sr.onresult({ resultIndex, results });
  };
})();
"""

NO_SPEECH_SCRIPT = """
Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true });
Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true });
Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
"""


class Session:
    """The running app + a browser context."""

    def __init__(self, pw, base: str, viewport, scale=1, init=INIT_SCRIPT, chromium_path=None):
        args = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
        self.browser = pw.chromium.launch(executable_path=chromium_path, args=args)
        self.ctx = self.browser.new_context(viewport=viewport, device_scale_factor=scale, permissions=["clipboard-read", "clipboard-write"])
        self.ctx.add_init_script(init)
        self.page = self.ctx.new_page()
        self.errors: list[str] = []
        self.page.on("pageerror", lambda e: self.errors.append(f"pageerror: {e}"))
        self.page.on("console", lambda m: self.errors.append(f"console.{m.type}: {m.text}")
                     if m.type == "error" and "Failed to load resource" not in m.text else None)
        self.base = base

    def open(self):
        self.page.goto(self.base + "/")
        self.page.wait_for_selector("#message-input")
        return self.page

    def close(self):
        self.browser.close()


def start_app(model_port: int, app_port: int, db: Path):
    env = dict(os.environ, AI_PROVIDER="openai", AI_BASE_URL=f"http://127.0.0.1:{model_port}/v1", AI_API_KEY="test",
               AI_MODEL="mock", SECRET_KEY="e2e-secret", DATABASE_PATH=str(db), AI_TIMEOUT_SECONDS="20")
    code = f"from app import create_app; create_app().run(host='127.0.0.1', port={app_port}, debug=False)"
    proc = subprocess.Popen([sys.executable, "-c", code], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{app_port}/api/health", timeout=1)
            return proc
        except Exception:
            time.sleep(0.25)
    proc.kill()
    raise RuntimeError("App did not start")


# ---- page helpers ------------------------------------------------------------------------------

def assistant_count(page) -> int:
    return page.locator(".msg-assistant .prose").count()


def send(page, text: str, expect_reply=True):
    before = assistant_count(page)
    page.fill("#message-input", text)
    page.press("#message-input", "Enter")
    if expect_reply:
        page.wait_for_function("n => document.querySelectorAll('.msg-assistant .prose').length > n", arg=before, timeout=15000)


def shot(page, shots: Path | None, name: str):
    if shots:
        shots.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(shots / name))


def toast_texts(page) -> list[str]:
    return page.locator(".toast-text").all_inner_texts()


def run_checks(pw, base, assets, chromium_path):
    s = Session(pw, base, {"width": 1280, "height": 860}, chromium_path=chromium_path)
    page = s.open()

    print("\nPage load")
    check("welcome screen visible", page.locator("#welcome").is_visible())
    check("custom fonts loaded", page.evaluate("document.fonts.check('16px \"Instrument Sans\"') && document.fonts.check('16px \"Bricolage Grotesque\"')"))
    check("send disabled when empty", page.locator("#send-btn").is_disabled())
    check("empty sidebar hint shown", page.locator("#conversation-empty").is_visible())

    print("\nText chat + Markdown")
    page.click(".starter[data-prompt^='Explain how neural']")
    check("starter fills the composer (not sent)", "neural networks" in page.input_value("#message-input") and assistant_count(page) == 0)
    page.press("#message-input", "Enter")
    page.wait_for_selector(".msg-assistant .thinking")
    check("thinking indicator shown while waiting", True)
    page.wait_for_selector(".msg-assistant .prose")
    check("welcome hidden once chatting", not page.locator("#welcome").is_visible())
    check("heading rendered", page.locator(".prose h2").count() == 1)
    check("ordered list rendered", page.locator(".prose ol li").count() == 4)
    check("code block with language label", page.locator(".codeblock-bar span").first.inner_text() == "python")
    check("table rendered in scroll wrapper", page.locator(".table-wrap table").count() == 1)
    check("link opens safely", page.locator(".prose a").get_attribute("rel") == "noopener noreferrer nofollow" and page.locator(".prose a").get_attribute("target") == "_blank")
    check("sidebar shows the new conversation, active", page.locator(".conv-item.is-active").count() == 1 and "Explain how neural" in page.locator(".conv-item.is-active .conv-select").inner_text())
    check("header shows conversation title", "Explain how neural" in page.locator("#chat-title").inner_text())
    page.click(".codeblock-copy")
    check("copy code button copies the code", "optimizer.step()" in page.evaluate("navigator.clipboard.readText()"))
    page.click(".msg-actions [data-action=copy]")
    check("copy response copies the Markdown source", page.evaluate("navigator.clipboard.readText()").startswith("## How neural networks learn"))

    print("\nText-to-speech")
    page.click("[data-action=speak]")
    page.wait_for_function("() => window.__speech.spoken.length > 0")
    first_chunk = page.evaluate("window.__speech.spoken[0]")
    check("speak button shows pressed state + stop label", page.get_attribute("[data-action=speak]", "aria-pressed") == "true" and "Stop" in page.get_attribute("[data-action=speak]", "aria-label"))
    check("global Stop speaking control appears", page.locator("#stop-speaking-btn").is_visible())
    for _ in range(40):  # let the engine "finish" each chunk so we can inspect everything that was spoken
        if not page.locator("#stop-speaking-btn").is_visible():
            break
        page.evaluate("window.__finishUtterance()")
    spoken = page.evaluate("window.__speech.spoken.join(' ')")
    check("speaks the reply in short chunks", first_chunk.startswith("How neural networks learn") and "guessing, measuring" in spoken and page.evaluate("window.__speech.spoken.length") > 3)
    check("code is not read out", "loss.backward" not in spoken and "Code block omitted" in spoken)
    page.click("[data-action=speak]")
    page.click("#stop-speaking-btn")
    check("Stop speaking cancels playback", page.evaluate("window.__speech.cancelled") > 0 and not page.locator("#stop-speaking-btn").is_visible())
    check("button resets after stop", page.get_attribute("[data-action=speak]", "aria-pressed") == "false")
    page.click("[data-action=speak]")
    page.click("[data-action=speak]")  # second click on the same button stops
    check("speaker button toggles playback off", not page.locator("#stop-speaking-btn").is_visible())
    page.click("[data-action=speak]")
    for _ in range(40):
        if not page.locator("#stop-speaking-btn").is_visible():
            break
        page.evaluate("window.__finishUtterance()")
    check("control hides itself when speech finishes", not page.locator("#stop-speaking-btn").is_visible())

    print("\nConversation context")
    send(page, "What did I just ask you about?")
    check("follow-up goes to the same conversation with history", "1 earlier message" in page.locator(".msg-assistant .prose").last.inner_text())
    check("still one conversation in sidebar", page.locator(".conv-item").count() == 1)

    print("\nImage upload")
    page.set_input_files("#file-input", str(assets["red.png"]))
    check("preview thumbnail shown", page.locator("#attachment-list .thumb img").count() == 1 and page.locator("#attachment-tray").is_visible())
    check("send enabled with image only", page.locator("#send-btn").is_enabled())
    page.click("#attachment-list .thumb-remove")
    check("remove button clears the preview", page.locator("#attachment-list .thumb").count() == 0 and not page.locator("#attachment-tray").is_visible())
    page.set_input_files("#file-input", str(assets["anim.gif"]))
    check("GIF rejected with message", any("supported image" in t for t in toast_texts(page)))
    page.set_input_files("#file-input", str(assets["big.png"]))
    check("oversized image rejected", any("limit is 5 MB" in t for t in toast_texts(page)))
    page.set_input_files("#file-input", str(assets["notes.txt"]))
    page.set_input_files("#file-input", str(assets["fake.png"]))
    page.wait_for_function("() => document.querySelectorAll('#attachment-list .thumb').length === 0")
    check("undecodable image removed with message", any("can't be read" in t for t in toast_texts(page)))
    page.set_input_files("#file-input", [str(assets["red.png"]), str(assets["photo.png"])])
    check("multiple images previewed", page.locator("#attachment-list .thumb").count() == 2)
    page.fill("#message-input", "What colour is the first image?")
    page.press("#message-input", "Enter")
    page.wait_for_function("n => document.querySelectorAll('.msg-assistant .prose').length > n", arg=2, timeout=15000)
    check("tray cleared after send", page.locator("#attachment-list .thumb").count() == 0)
    check("sent bubble shows image thumbnails", page.locator(".msg-user").last.locator(".msg-thumb img").count() == 2)
    reply = page.locator(".msg-assistant .prose").last.inner_text()
    check("reply is the model's analysis of the real image", "64x48 PNG" in reply and "red" in reply, reply)

    page.set_input_files("#file-input", str(assets["photo.png"]))
    page.press("#message-input", "Enter")
    page.wait_for_function("n => document.querySelectorAll('.msg-assistant .prose').length > n", arg=3, timeout=15000)
    check("image-only message works (default prompt)", "640x420 PNG" in page.locator(".msg-assistant .prose").last.inner_text())

    print("\nDrag and drop + paste")
    page.evaluate("""(b64) => {
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const dt = new DataTransfer(); dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
        window.__dt = dt;
        document.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }""", base64.b64encode(png_bytes((32, 32), "blue")).decode())
    check("drop overlay appears on drag", page.locator("#drop-overlay").is_visible())
    page.evaluate("document.dispatchEvent(new DragEvent('drop', { dataTransfer: window.__dt, bubbles: true, cancelable: true }))")
    check("overlay hides and dropped image is attached", not page.locator("#drop-overlay").is_visible() and page.locator("#attachment-list .thumb").count() == 1)
    page.evaluate("""() => {
        const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(1)], 'x.png', { type: 'image/png' }));
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        document.getElementById('message-input').dispatchEvent(ev);
    }""")
    page.wait_for_timeout(300)
    page.click("#attachment-list .thumb-remove >> nth=0")
    page.click("#attachment-list .thumb-remove >> nth=0") if page.locator("#attachment-list .thumb").count() else None
    check("attachments can all be removed", page.locator("#attachment-list .thumb").count() == 0)

    print("\nVoice input")
    page.fill("#message-input", "Hello")
    page.click("#mic-btn")
    page.wait_for_selector("#listening-indicator", state="visible")
    check("listening indicator + pressed state", page.get_attribute("#mic-btn", "aria-pressed") == "true" and "Stop" in page.get_attribute("#mic-btn", "aria-label"))
    check("status announces listening", "Listening" in page.inner_text("#composer-status"))
    page.evaluate("window.__emit([{t:'how is the', final:false}], 0)")
    check("interim text appears in the box", page.input_value("#message-input") == "Hello how is the")
    page.evaluate("window.__emit([{t:'how is the weather', final:true}], 0)")
    page.evaluate("window.__emit([{t:'how is the weather', final:true},{t:' today', final:false}], 1)")
    check("final + interim combine, existing text kept", page.input_value("#message-input") == "Hello how is the weather today")
    page.click("#mic-btn")
    page.wait_for_function("() => document.getElementById('mic-btn').getAttribute('aria-pressed') === 'false'")
    check("stop returns to idle and keeps editable text", page.input_value("#message-input") == "Hello how is the weather today" and not page.locator("#listening-indicator").is_visible())
    page.fill("#message-input", "")
    page.click("#mic-btn")
    page.wait_for_selector("#listening-indicator", state="visible")
    page.type("#message-input", "x")
    page.wait_for_function("() => document.getElementById('mic-btn').getAttribute('aria-pressed') === 'false'")
    check("typing while dictating stops dictation", True)
    page.fill("#message-input", "")
    page.evaluate("window.__srMode = 'deny'")
    page.click("#mic-btn")
    page.wait_for_selector(".toast.is-error")
    check("blocked microphone shows clear guidance", any("Microphone access is blocked" in t for t in toast_texts(page)))
    page.evaluate("window.__srMode = ''")
    page.wait_for_function("() => document.getElementById('mic-btn').getAttribute('aria-pressed') === 'false'")

    print("\nErrors and retry")
    send(page, "trigger-500 please", expect_reply=False)
    page.wait_for_selector(".msg-user.is-failed")
    check("failed send shows reason and actions", page.locator(".msg-fail").inner_text().startswith("Not sent."))
    page.click(".msg-fail [data-action=discard]")
    check("discard removes the failed message", page.locator(".msg-user.is-failed").count() == 0)
    n = assistant_count(page)
    send(page, "flaky request", expect_reply=False)
    page.wait_for_selector(".msg-user.is-failed")
    page.click(".msg-fail [data-action=retry]")
    page.wait_for_function("n => document.querySelectorAll('.msg-assistant .prose').length > n", arg=n, timeout=15000)
    check("Try again resends and succeeds", page.locator(".msg-user.is-failed").count() == 0)

    print("\nHistory")
    expected_users = page.locator(".msg-user").count()
    page.reload()
    page.wait_for_selector(".msg-user")
    check("reload restores the last conversation", page.locator(".msg-user").count() == expected_users and "Explain how neural" in page.locator("#chat-title").inner_text())
    check("history renders Markdown", page.locator(".codeblock").count() == 1)
    chips = page.locator(".msg-chip")
    check("past images show metadata chips", chips.count() == 3 and "red.png" in chips.first.inner_text() and "64\u00d748" in chips.first.inner_text(), chips.all_inner_texts().__str__())
    page.click("#new-chat-btn")
    check("New chat shows the welcome screen", page.locator("#welcome").is_visible() and page.locator(".msg").count() == 0 and page.input_value("#message-input") == "")
    send(page, "Second conversation")
    check("second conversation listed on top", page.locator(".conv-item").count() == 2 and "Second conversation" in page.locator(".conv-item").first.inner_text())
    page.locator(".conv-item >> nth=1").locator(".conv-select").click()
    page.wait_for_selector(".codeblock")
    check("selecting an old conversation loads it", "Explain how neural" in page.locator("#chat-title").inner_text())

    print("\nRename and delete")
    item = page.locator(".conv-item.is-active")
    item.hover()
    item.get_by_role("button", name="Rename").click()
    page.keyboard.press("Control+A")
    page.keyboard.type("Neural nets primer")
    page.keyboard.press("Enter")
    page.wait_for_function("() => document.querySelector('.conv-item.is-active .conv-select')?.textContent === 'Neural nets primer'")
    check("rename updates sidebar and header", page.locator("#chat-title").inner_text() == "Neural nets primer")
    item = page.locator(".conv-item.is-active")
    item.hover()
    item.get_by_role("button", name="Rename").click()
    page.keyboard.type(" extra")
    page.keyboard.press("Escape")
    check("Escape cancels rename", page.locator(".conv-item.is-active .conv-select").inner_text() == "Neural nets primer")
    item.hover()
    item.get_by_role("button", name="Delete").click()
    check("delete asks for confirmation", page.locator("#confirm-dialog").is_visible())
    page.click("#confirm-cancel")
    check("cancel keeps the conversation", page.locator(".conv-item").count() == 2 and not page.locator("#confirm-dialog").is_visible())
    item.hover()
    item.get_by_role("button", name="Delete").click()
    page.click("#confirm-ok")
    page.wait_for_function("() => document.querySelectorAll('.conv-item').length === 1")
    check("delete removes it and returns to a new chat", page.locator("#welcome").is_visible() and page.locator("#chat-title").inner_text() == "New chat")

    print("\nAccessibility basics")
    unnamed = page.evaluate("""() => [...document.querySelectorAll('button, input, textarea')].filter(el => {
        if (el.type === 'file') return false;
        const label = el.getAttribute('aria-label') || el.textContent.trim() || (el.labels && el.labels.length) || el.getAttribute('title');
        return !label; }).map(el => el.outerHTML.slice(0, 80))""")
    check("every control has an accessible name", not unnamed, str(unnamed))
    check("message list is a labelled live region", page.get_attribute("#thread", "aria-label") == "Conversation")
    page.focus(".skip-link")
    page.wait_for_timeout(300)  # let the 150 ms slide-in finish
    check("skip link becomes visible on focus", page.evaluate("document.querySelector('.skip-link').getBoundingClientRect().top") >= 0)
    page.keyboard.press("Enter")
    check("skip link moves focus to the message box", page.evaluate("document.activeElement.id") == "message-input")

    print("\nBrowser console")
    check("no console errors or CSP violations", not s.errors, "; ".join(s.errors))
    s.close()


def run_unsupported(pw, base, chromium_path):
    print("\nUnsupported browser (no speech APIs)")
    s = Session(pw, base, {"width": 1280, "height": 860}, init=NO_SPEECH_SCRIPT, chromium_path=chromium_path)
    page = s.open()
    check("mic marked unavailable", page.get_attribute("#mic-btn", "aria-disabled") == "true")
    page.click("#mic-btn", force=True)  # aria-disabled (not disabled): users can still click and get an explanation
    page.wait_for_selector(".toast.is-error")
    check("mic click explains the limitation", "isn't supported" in page.inner_text(".toast-text"))
    page.click(".toast .icon-btn")
    check("toast can be dismissed", page.locator(".toast").count() == 0)
    send(page, "Hello there")
    check("text chat still works", "You said: Hello there" in page.locator(".msg-assistant .prose").last.inner_text())
    page.click("[data-action=speak]", force=True)
    page.wait_for_selector(".toast.is-error")
    check("speaker button explains the limitation", any("isn't supported" in t for t in toast_texts(page)))
    s.close()


def run_mobile(pw, base, chromium_path, shots):
    print("\nMobile layout")
    s = Session(pw, base, {"width": 390, "height": 844}, scale=2, chromium_path=chromium_path)
    page = s.open()
    check("sidebar hidden by default", not page.locator("#sidebar").is_visible())
    check("no horizontal overflow", page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))
    shot(page, shots, "mobile-welcome.png")
    page.click("#menu-btn")
    page.wait_for_selector("#sidebar.is-open")
    page.wait_for_timeout(450)  # let the slide-in finish before checking / capturing
    check("menu opens the drawer", page.get_attribute("#menu-btn", "aria-expanded") == "true" and page.locator("#scrim").is_visible())
    shot(page, shots, "mobile-drawer.png")
    page.keyboard.press("Escape")
    page.wait_for_function("() => !document.getElementById('sidebar').classList.contains('is-open')")
    check("Escape closes the drawer", not page.locator("#scrim").is_visible())
    page.click("#menu-btn")
    page.click("#scrim", position={"x": 370, "y": 400})
    page.wait_for_function("() => !document.getElementById('sidebar').classList.contains('is-open')")
    check("scrim click closes the drawer", True)
    page.click("#menu-btn")
    page.click("#sidebar-close-btn")
    check("close button closes the drawer", not page.locator("#scrim").is_visible())
    send(page, "Explain how neural networks learn, in plain language.")
    check("no horizontal overflow with Markdown + table", page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"))
    shot(page, shots, "mobile-chat.png")
    s.close()


def run_screenshots(pw, base, assets, chromium_path, shots: Path):
    print("\nScreenshots ->", shots)
    s = Session(pw, base, {"width": 1280, "height": 800}, scale=1, chromium_path=chromium_path)
    page = s.open()
    shot(page, shots, "welcome.png")
    page.click(".starter[data-prompt^='Explain how neural']")
    page.press("#message-input", "Enter")
    page.wait_for_selector(".msg-assistant .prose")
    page.wait_for_timeout(300)
    page.click("[data-action=speak]")
    page.evaluate("document.getElementById('thread').scrollTop = 0")
    page.mouse.move(900, 400)
    page.wait_for_timeout(350)
    shot(page, shots, "chat-markdown.png")
    page.click("#stop-speaking-btn")
    page.click("#new-chat-btn")
    page.set_input_files("#file-input", str(assets["photo.png"]))
    page.fill("#message-input", "What colours dominate this image?")
    shot(page, shots, "image-attached.png")
    page.press("#message-input", "Enter")
    page.wait_for_function("() => document.querySelectorAll('.msg-assistant .prose').length > 0")
    page.wait_for_timeout(300)
    shot(page, shots, "image-analysis.png")
    page.click("#new-chat-btn")
    page.fill("#message-input", "Remind me to book the")
    page.click("#mic-btn")
    page.wait_for_selector("#listening-indicator", state="visible")
    page.evaluate("window.__emit([{t:'train tickets for Friday', final:false}], 0)")
    page.mouse.move(900, 300)
    page.wait_for_timeout(450)
    shot(page, shots, "voice-listening.png")
    s.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--screenshots", metavar="DIR", help="also write README screenshots to DIR")
    parser.add_argument("--screenshots-only", action="store_true", help="skip the checks")
    args = parser.parse_args()
    shots = Path(args.screenshots) if args.screenshots else None
    chromium_path = os.environ.get("CHROMIUM_PATH") or None

    model_port, app_port = free_port(), free_port()
    mock_model_server.serve(model_port)
    tmp = Path(tempfile.mkdtemp(prefix="chatbot-e2e-"))
    assets = make_assets(tmp)

    def fresh_app(name):
        return start_app(model_port, app_port, tmp / f"{name}.db")

    base = f"http://127.0.0.1:{app_port}"
    with sync_playwright() as pw:
        if not args.screenshots_only:
            for name, fn in (("checks", lambda: run_checks(pw, base, assets, chromium_path)),
                             ("unsupported", lambda: run_unsupported(pw, base, chromium_path)),
                             ("mobile", lambda: run_mobile(pw, base, chromium_path, None))):
                proc = fresh_app(name)
                try:
                    fn()
                finally:
                    proc.terminate(); proc.wait()
        if shots:
            proc = fresh_app("shots")
            try:
                run_screenshots(pw, base, assets, chromium_path, shots)
                run_mobile(pw, base, chromium_path, shots)
            finally:
                proc.terminate(); proc.wait()

    print("\n" + ("ALL CHECKS PASSED" if not FAILURES else f"{len(FAILURES)} CHECK(S) FAILED: " + ", ".join(FAILURES)))
    sys.exit(1 if FAILURES else 0)


if __name__ == "__main__":
    main()
