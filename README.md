# Conversational AI Chatbot

A Flask + SQLite chatbot with a dark, responsive web interface. It supports text chat with Markdown replies,
**image recognition** (a vision-capable model describes your uploads), **voice input** (speech-to-text in the
message box) and **read-aloud** (text-to-speech on every reply).

| | |
|---|---|
| ![Welcome screen](docs/screenshots/welcome.png) | ![Markdown reply with code and table](docs/screenshots/chat-markdown.png) |
| ![Image attached](docs/screenshots/image-attached.png) | ![Image analysis](docs/screenshots/image-analysis.png) |
| ![Voice input listening](docs/screenshots/voice-listening.png) | ![Mobile layout](docs/screenshots/mobile-chat.png) |

> **About these screenshots.** They were captured from the real app in real Chromium, but the AI replies came from a
> small local stand-in server (`scripts/mock_model_server.py`), not from a real model, so no API key was needed.
> The image reply is genuinely computed from the uploaded pixels by the stand-in; the wording is not what a real
> vision model would write. Regenerate them any time with the command in [Screenshots](#screenshots).

## Features

- **Text chat** with conversation history, saved in SQLite, with context sent on every follow-up.
- **Markdown replies**: headings, lists, tables, links, quotes and code blocks with a **Copy** button. Output is
  sanitized (no scripts, no remote images, links open safely).
- **Images**: pick, drag and drop, or paste. Thumbnails with remove buttons, type/size/count checks before upload,
  and a clear message if the server or model rejects the image.
- **Voice input**: microphone button inserts recognised text into the message box so you can edit before sending.
  Start/stop, a listening indicator, and explicit messages for blocked permission, no microphone or no network.
- **Read aloud**: speaker button on each reply (code blocks are skipped) plus a global **Stop speaking** control.
- **Sidebar**: new chat, switch, rename, delete (with confirmation). Becomes a slide-over drawer on phones.
- **Accessible**: labelled controls, visible focus, skip link, live regions for status and errors, keyboard
  support (Enter to send, Esc to close drawers/dialogs/rename), `prefers-reduced-motion` respected.

## Setup

Requires Python 3.10+ and an API key for a vision-capable model. Node.js is **not** needed to run the app.

### Windows
```bat
cd conversational-ai-chatbot
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

### macOS / Linux
```bash
cd conversational-ai-chatbot
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Edit `.env`:

| Variable | Meaning |
|---|---|
| `SECRET_KEY` | Any long random string (signs the session cookie) |
| `AI_PROVIDER` | `anthropic` or `openai` (any OpenAI-compatible API) |
| `AI_API_KEY` | Your key. It stays on the server and is never sent to the browser |
| `AI_MODEL` | A **vision-capable** model name from your provider |
| `AI_BASE_URL` | Optional; needed only for OpenAI-compatible servers other than OpenAI |
| `AI_SUPPORTS_VISION` | Set `false` only if your model cannot read images |
| `MAX_IMAGES_PER_REQUEST`, `MAX_IMAGE_MB`, `MAX_MESSAGE_CHARS`, `HISTORY_MESSAGE_LIMIT` | Limits. The page reads the first three, so the UI always matches the server |

No new environment variables were needed for Part 2.

## Run

```bash
python app.py        # http://127.0.0.1:5000
```

Open it in **Chrome, Edge or Safari** for voice input (see [Browser support](#browser-support)).

## Using it

- **Send**: Enter. New line: Shift+Enter.
- **Attach images**: click the image button, drop files anywhere on the page, or paste an image into the box.
  JPEG, PNG or WebP, up to 4 images and 5 MB each (configurable). Add a question, or send the image alone to get a
  description.
- **Dictate**: click the microphone, allow access when the browser asks, speak, click again to stop. The text lands
  in the box at the cursor. Typing while dictating ends dictation. Sending ends it too.
- **Listen**: click the speaker under a reply. Click again, or use **Stop speaking** in the top bar.
- **Failed send**: the message stays on screen marked "Not sent" with the reason, **Try again** and **Discard**.

## Browser support

| Feature | Chrome / Edge | Safari | Firefox |
|---|---|---|---|
| Chat, images, Markdown, read aloud | Yes | Yes | Yes |
| Voice input (SpeechRecognition) | Yes | Yes (needs Dictation enabled) | **No**: the button explains this |

- Voice input needs **HTTPS or `localhost`** (browser rule for microphone access).
- In Chrome and Edge, speech recognition is performed by the browser vendor's online service, so audio leaves your
  device and it needs an internet connection. Mention this to your users.
- Language for dictation and read-aloud follows the browser language.

## Testing

Three layers; the first needs only Python.

```bash
# 1. Python: Part 1 backend (28 tests) + frontend wiring, CSP and static assets (13 tests)
python -m unittest discover -s tests -v

# 2. JavaScript unit + integration tests (51 tests; Node 22+; jsdom, no browser)
npm install
npm test

# 3. Real-browser end-to-end check of every control (Chromium via Playwright)
pip install -r requirements-dev.txt
playwright install chromium
python scripts/e2e.py
```

What each layer covers:

- `tests/test_frontend.py`: page renders with CSRF token and live limits; every asset is served; the CSP has no
  external hosts, `unsafe-inline` or `unsafe-eval`; every element id used by JavaScript exists in the template; every
  icon exists; text-only multipart posts still work with the Part 1 API.
- `tests/js/*.test.mjs`: Markdown rendering and sanitisation, speech chunking and state, dictation insertion
  (caret, interim/final, errors, unsupported), attachment validation and previews, API client, and a full app
  integration suite (send, retry, history, rename, delete, drawer, voice, read-aloud, race conditions).
- `scripts/e2e.py`: drives the real UI in Chromium against the real Flask app and checks 78 behaviours, including
  console/CSP errors. Headless browsers have no microphone or voices, so it injects **fake** `SpeechRecognition` and
  `speechSynthesis`. Set `CHROMIUM_PATH` to use a Chromium you already have.

### Testing with your real model

```bash
python app.py
```
Send a message, then attach a photo and ask about it. The same check from the command line:

```bash
curl -c jar.txt -s localhost:5000/ | grep csrf-token
curl -b jar.txt -H "X-CSRFToken: <token>" -F "message=What is in this image?" -F "images=@photo.jpg" localhost:5000/api/chat
```

### Manual checklist (real microphone and speakers)
Automated tests cannot cover the real hardware paths. Check once per browser you support:

- [ ] Microphone: allow, dictate a sentence, text appears and is editable; stop works.
- [ ] Microphone: block permission in site settings, click the mic, the guidance toast appears.
- [ ] Read aloud: speaks a long reply to the end without cutting off; **Stop speaking** silences it immediately.
- [ ] Image: upload a real photo, the reply describes it; upload a renamed `.txt` as `.png`, you get an error.
- [ ] Phone width: drawer opens and closes, composer stays above the keyboard, nothing scrolls sideways.

## Screenshots

```bash
python scripts/e2e.py --screenshots docs/screenshots
```

## Project layout

```
app.py, config.py, security.py      Flask factory, env config, session/CSRF/CSP headers      (Part 1)
routes/                             main.py (page), chat.py, conversations.py (JSON API)
models/db.py                        SQLite access, every query scoped to the session owner
services/                           ai_service.py (providers), image_service.py (validation)
templates/index.html                The whole interface markup + icon sprite                 (Part 2)
static/css/styles.css               Design tokens and components
static/js/                          ES modules, no build step:
  main.js        entry point                      app.js        wires everything, conversation flow
  api.js         fetch client + CSRF              composer.js   input, send rules, drag/drop, paste, mic
  attachments.js image validation + previews      voice.js      SpeechRecognition wrapper
  speech.js      speechSynthesis wrapper          messages.js   thread rendering, copy, read aloud
  markdown.js    marked + DOMPurify               sidebar.js    list, rename, delete, mobile drawer
  ui.js          DOM helpers, toasts, dialogs
static/vendor, static/fonts         marked, DOMPurify and fonts, self-hosted (see static/vendor/README.md)
tests/                              Python tests + tests/js (Node)
scripts/                            e2e.py, mock_model_server.py (test double), sync_vendor.mjs
```

Updating the vendored libraries: `npm install && npm run vendor`.

## API

All `POST/PATCH/DELETE` calls need the `X-CSRFToken` header (value is in `<meta name="csrf-token">`).

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/` | Chat page |
| POST | `/api/chat` | multipart `message`, `conversation_id`, `images` (repeatable) or JSON `{message, conversation_id?}` |
| GET | `/api/conversations` | List your conversations |
| GET | `/api/conversations/<id>` | Conversation with messages |
| PATCH | `/api/conversations/<id>` | Rename `{title}` |
| DELETE | `/api/conversations/<id>` | Delete |

Errors are `{error}` with 400 (bad input), 404, 413 (too large), 415 (bad image), 422 (model lacks vision),
429 (rate limit) and 502/503/504 (AI service unreachable, unconfigured, timed out).

## Security notes

- The API key lives only in the server environment. Conversations belong to an anonymous signed-session owner.
- Images are validated by decoding them (not by extension), limited by size, count and pixels, held in memory and
  never written to disk. Only metadata is stored.
- **CSP**: scripts, styles and fonts are served from this app only. Part 1 allowed two CDNs; Part 2 removed them
  because everything is now vendored. There is no inline script or style.
- Assistant Markdown is parsed by `marked` and sanitised by DOMPurify. Images, iframes, forms, inline styles and
  non-http(s)/mailto links are stripped. User text is always shown as plain text.
- Set `SESSION_COOKIE_SECURE=true` behind HTTPS.

## Known limitations

- **Past images are not shown or re-sent.** Part 1 stores only metadata, so after a reload an image message shows a
  chip (name, dimensions, size) instead of the picture, and follow-up questions cannot "see" earlier images again.
  Showing them would need server-side image storage.
- Replies arrive all at once (no streaming) and an in-flight request cannot be cancelled.
- No user accounts: history is tied to the browser's session cookie (30 days). Clearing cookies orphans it.
- Voice input is unavailable in Firefox, depends on the browser's online recognition service in Chrome/Edge, and
  uses the browser language. No language picker.
- Read-aloud voice quality depends on the voices installed on the device.
- The automated tests use fakes for speech APIs and a stand-in for the AI API. Real microphone, real voices and a
  real vision model are covered only by the manual checklist above. Safari and iOS were not tested in this build.
- The UI is dark only.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "The AI service is not configured" | Set `AI_API_KEY` and `AI_MODEL` in `.env`, restart |
| "…does not support images" | Use a vision-capable `AI_MODEL`, keep `AI_SUPPORTS_VISION=true` |
| "Missing or invalid CSRF token" | Reload the page (the session cookie expired or was cleared) |
| Mic button greyed out | Browser has no SpeechRecognition (e.g. Firefox). Use Chrome, Edge or Safari |
| "Microphone access is blocked" | Allow the microphone for the site in browser settings, then retry |
| Mic does nothing on a LAN address | Voice needs HTTPS or `localhost`; plain `http://192.168.x.x` is blocked by browsers |
| Fonts look different | Check that `static/fonts/*.woff2` exist (`npm run vendor` restores them) |
