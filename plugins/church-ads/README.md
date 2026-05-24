# church-ads

Process CCS Seattle Sunday church announcements: PDF photos + Apple Voice Memo recording -> bilingual EN/KO per-ad markdown files with regenerated clean slide images, optionally pushed to the Sanity CMS.

## Skills

| Skill | Invocation | Purpose |
|-------|-----------|---------|
| `process-ads` | `/church-ads:process-ads` | Phases 0-3: extract PDF pages, transcribe voice, segment + translate via Gemini, write per-ad MDs |
| `push-to-sanity` | `/church-ads:push-to-sanity` | Phase 4: parse MDs -> generate `studio/add-MMDD-events.mjs` -> run -> trigger Cloudflare rebuild |

## Pipeline

```
.church-ads.raw/YYYYMMDD.church-ads/
├── church-ads-YYYYMMDD.pdf              [input]
├── raw/
│   ├── page-1.png ... page-N.png        [pdftoppm]
│   ├── voice.m4a                        [copied from Voice Memos]
│   ├── transcript.md                    [OpenAI gpt-4o-transcribe]
│   └── segments.json                    [Gemini 3.5 Flash: per-ad chunks]
├── 01-{slug}.md ... NN-{slug}.md        [per-ad bilingual MDs]
└── regen-{slug}.png                     [nano-banana edit_image, in-session]
```

## Models

| Step | Model |
|------|-------|
| Transcribe (m4a -> text) | `gpt-4o-transcribe` (OpenAI) |
| Segment + translate | `gemini-3.5-flash` (Google) |
| Slide image regen | `gemini-2.5-flash-image` (nano-banana MCP) |

## Setup

```bash
cd ~/.claude/plugins/marketplaces/won-plugins/plugins/church-ads
bun install
```

Required env (loaded from `~/.config/.env.d`):
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`

Required tools on PATH:
- `pdftoppm` (Poppler) — `brew install poppler`
- `bun`

## Voice Memo location (macOS Tahoe 26)

```
~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings/YYYYMMDD HHMMSS.m4a
```

Files are named with a literal space, not underscore — quote when scripting.

## Hero rule

At most one event has `primary: true`. The Sanity Studio publish action and the migration script both enforce this — setting a new hero unsets all others transactionally.
