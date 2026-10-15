"""A tiny OpenAI-compatible model server for TESTING AND SCREENSHOTS ONLY.

It is NOT part of the application and is never used at runtime. scripts/e2e.py points the real app at
it (AI_PROVIDER=openai, AI_BASE_URL=http://127.0.0.1:<port>/v1) so browser tests are deterministic and
need no API key.

For images it genuinely decodes the upload with Pillow and reports real facts (size, format, dominant
colour). For text it returns a few scripted Markdown replies keyed by words in the prompt.
Special prompts: "trigger-500" always fails, "flaky" fails once then succeeds, "slow" waits 2 s.
"""
from __future__ import annotations

import base64
import io
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image

MARKDOWN_REPLY = """## How neural networks learn

A neural network improves by **guessing, measuring its mistake, and adjusting**. Think of tuning a radio: you nudge the dial, listen, and nudge again until the signal is clear.

1. **Forward pass** - the input flows through layers of weighted connections to produce a guess.
2. **Loss** - a number says how wrong the guess was.
3. **Backpropagation** - the error is traced backwards to find which weights contributed most.
4. **Update** - each weight moves a small step to reduce the error.

```python
for batch in data:
    prediction = model(batch.x)
    loss = loss_fn(prediction, batch.y)
    loss.backward()      # compute gradients
    optimizer.step()     # nudge the weights
    optimizer.zero_grad()
```

| Term | Meaning |
|---|---|
| Epoch | One full pass over the training data |
| Learning rate | How big each nudge is |

> Repeat this millions of times and the guesses become good.

Read more at [Wikipedia](https://en.wikipedia.org/wiki/Neural_network)."""


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    return " ".join(p.get("text", "") for p in content if p.get("type") == "text")


def _describe_image(data_url: str) -> str:
    raw = base64.b64decode(data_url.split(",", 1)[1])
    with Image.open(io.BytesIO(raw)) as img:
        fmt, (w, h) = img.format, img.size
        small = img.convert("RGB").resize((1, 1))
        r, g, b = small.getpixel((0, 0))
    names = {"red": (r > 150 and g < 100 and b < 100), "green": (g > 150 and r < 100 and b < 100),
             "blue": (b > 150 and r < 100 and g < 100)}
    name = next((n for n, hit in names.items() if hit), "mixed")
    return (f"I can see a **{w}x{h} {fmt}** image. Its average colour is about `rgb({r}, {g}, {b})`, "
            f"which reads as **{name}**.\n\nThis description was produced by the local test server, "
            "not by a real vision model.")


class Handler(BaseHTTPRequestHandler):
    flaky_seen: set[str] = set()
    lock = threading.Lock()

    def log_message(self, *args):  # keep test output quiet
        pass

    def _send(self, status: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        req = json.loads(self.rfile.read(length) or b"{}")
        messages = req.get("messages", [])
        last = messages[-1]["content"] if messages else ""
        text = _text_of(last)
        lowered = text.lower()

        if "trigger-500" in lowered:
            return self._send(500, {"error": "boom"})
        if "flaky" in lowered:
            with self.lock:
                first = text not in self.flaky_seen
                self.flaky_seen.add(text)
            if first:
                return self._send(500, {"error": "temporary"})
        if "slow" in lowered:
            time.sleep(2)

        images = [p["image_url"]["url"] for p in last if isinstance(last, list) and p.get("type") == "image_url"]
        if images:
            reply = _describe_image(images[0])
        elif "neural" in lowered:
            reply = MARKDOWN_REPLY
        else:
            prior = sum(1 for m in messages[:-1] if m["role"] == "user")
            reply = (f"You said: {text}\n\nI can see {prior} earlier message{'s' if prior != 1 else ''} "
                     "from you in this conversation.")
        self._send(200, {"choices": [{"message": {"role": "assistant", "content": reply}}]})


def serve(port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5599
    print(f"Mock model server on http://127.0.0.1:{port}/v1")
    serve(port)
    threading.Event().wait()
