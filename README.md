# Sectioner

**Edit AI-generated documents section by section — without retyping context every time.**

Sectioner generates structured documents with Claude and lets you edit them one section at a time. Click a section, type your instruction, see only what changed.

![Sectioner screenshot](https://raw.githubusercontent.com/hari-kris/sectioner/main/screenshot.png)

---

## The problem

When editing long AI-generated documents you end up typing things like:

> *"In the Executive Summary section, make it more concise and adjust the tone for a technical audience"*

Every edit requires you to re-specify the location, re-state the audience, re-set the tone. The AI regenerates the whole document and you scroll to find what changed.

Sectioner fixes this with a simple idea: **selection replaces description**.

---

## Features

- **Section-aware editing** — click any section to open it in the edit panel. You type only the change, not the location.
- **Diff view** — after each edit, only the changed section highlights with word-level before/after diffs.
- **Constraint lock** — set tone, audience, length, and custom rules once. They apply silently to every edit.
- **Per-section undo** — last 3 states per section, no API call needed.
- **Consistency check** — one-click full-document review that surfaces contradictions and terminology drift.
- **Export** — copy to clipboard, download as `.md` or `.txt`.

---

## Getting started

You need an [Anthropic API key](https://console.anthropic.com).

**1. Clone the repo**

```bash
git clone https://github.com/hari-kris/sectioner.git
cd sectioner
```

**2. Start the local server**

```bash
python3 server.py
```

**3. Open in your browser**

```
http://localhost:8080
```

Enter your API key on the landing screen and start writing.

> The server is a thin local proxy — it serves the static files and forwards API calls to Anthropic server-side to avoid browser CORS restrictions. Your API key is never stored anywhere.

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | Vanilla HTML / CSS / JavaScript — no framework, no build step |
| AI | [Anthropic Claude](https://anthropic.com) (`claude-sonnet-4-20250514`) |
| Server | Python 3 standard library (`http.server`) — no dependencies |
| Storage | In-memory only — nothing persisted to disk |

---

## Project structure

```
sectioner/
├── index.html    # App shell — landing screen + three-column layout
├── styles.css    # All styles — light theme, diff highlighting, animations
├── app.js        # All application logic — state, LCS diff, API calls, render
├── server.py     # Local proxy server — static files + Anthropic API forwarding
└── README.md
```

---

## How it works

1. You describe a document → Claude generates it with `##` markdown headings
2. The app parses headings into named sections and renders a three-column view
3. Clicking a section opens the edit panel with the current content shown read-only
4. You type an instruction → the full document is sent to Claude for coherence, but only the target section is returned and patched
5. A word-level LCS diff highlights what changed in green/red

---

## License

MIT — see [LICENSE](LICENSE).
