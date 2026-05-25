---
name: process-ads
description: Use when the user has a Sunday church announcement PDF (photographed slides) and an Apple Voice Memo recording, and wants per-ad bilingual EN/KO markdown with regenerated clean slide images. Input dir is `.church-ads.raw/YYYYMMDD.church-ads/` containing `church-ads-YYYYMMDD.pdf`. Triggers on "process church ads", "process Sunday announcements", "extract today's announcements", or `/church-ads:process-ads`.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, AskUserQuestion
---

# Process Church Ads

Pipeline for CCS Seattle Sunday announcements: PDF + Voice Memo -> per-ad bilingual MDs with regenerated slide images.

## When to Use

User has dropped a PDF in `.church-ads.raw/YYYYMMDD.church-ads/`. They want structured per-ad output without manually transcribing or laying out anything.

Symptoms:
- "Process today's announcements"
- "Process church ads from <date>"
- New PDF appeared in `.church-ads.raw/`

## Inputs

| File | Source | Required |
|------|--------|----------|
| `church-ads-YYYYMMDD.pdf` | iPhone photos of slides | yes |
| `~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings/YYYYMMDD HHMMSS.m4a` | Apple Voice Memo | yes (auto-found by date) |

Voice memo path on macOS Tahoe 26 = `~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings/`. Files named `YYYYMMDD HHMMSS.m4a`.

## Outputs

`.church-ads.raw/YYYYMMDD.church-ads/`:
- `raw/page-N.png` — extracted PDF pages
- `raw/voice.m4a` — copied voice memo
- `raw/transcript.md` — full transcription
- `raw/segments.json` — Gemini segmentation result
- `01-{slug}.md`, `02-{slug}.md`, ... — per-ad MD files
- `regen-{slug}.en.png` / `regen-{slug}.ko.png` — nano-banana regenerated clean slide images, separate per language

## Pipeline

```
PDF -> pdftoppm -> page-N.png
Voice memo -> OpenAI gpt-4o-transcribe -> transcript.md
transcript + page images -> Gemini 3.5 Flash -> segments.json (per-ad chunks + bilingual fields)
For each ad x lang: page PNG -> nano-banana (gemini-3.1-flash-image-preview) -> regen-{slug}.{en|ko}.png
For each ad: write {NN}-{slug}.md
```

## Models

| Step | Model | Provider |
|------|-------|----------|
| Transcribe | `gpt-4o-transcribe` | OpenAI |
| Segment + translate | `gemini-3.5-flash` | Google |
| Regen slide image | `gemini-2.5-flash-image` (nano-banana) | Google MCP |

## Workflow

### 1. Find inputs

```bash
DATE=20260524  # ask user if not obvious
RAW_DIR=".church-ads.raw/${DATE}.church-ads"
PDF="${RAW_DIR}/church-ads-${DATE}.pdf"
VM_DIR="$HOME/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings"
VOICE=$(ls "$VM_DIR"/${DATE}*.m4a 2>/dev/null | head -1)
```

If PDF or voice missing -> stop, ask user.

### 2. Run the pipeline script

```bash
cd <repo-root>
bun run ${CLAUDE_PLUGIN_ROOT}/scripts/process-ads.ts \
  --date "$DATE" \
  --pdf "$PDF" \
  --voice "$VOICE" \
  --out "$RAW_DIR"
```

The script:
- Loads creds from `~/.config/.env.d` (`OPENAI_API_KEY`, `GEMINI_API_KEY`)
- Extracts PDF pages via `pdftoppm` (must be on PATH)
- Transcribes voice memo
- Calls Gemini for segmentation + bilingual translation
- Writes `transcript.md`, `segments.json`, per-ad MD files
- Returns list of regen prompts (one per ad) for Phase 2

### 3. Regenerate slide images (EN + KO per ad)

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/scripts/regen-images.ts --out "$RAW_DIR"
```

Produces `regen-{slug}.en.png` + `regen-{slug}.ko.png` for each ad. Each language is rendered exclusively in its own language (no mixing). Layout/style stays consistent between versions.

The script uses Gemini directly via `@google/genai` (same model as nano-banana MCP: `gemini-3.1-flash-image-preview`) — bypasses the MCP server because MCP env may not propagate `GEMINI_API_KEY`. Loads creds from `~/.config/.env.d`.

### 4. Verify outputs

```bash
ls -la "$RAW_DIR"/*.md "$RAW_DIR"/regen-*.en.png "$RAW_DIR"/regen-*.ko.png
```

Each ad MD embeds both EN + KO regen images:

```markdown
# {Title EN} / {Title KO}

EN: ![{Title}](regen-{slug}.en.png)

KO: ![{Title}](regen-{slug}.ko.png)

- **Date:** ...
- **Time:** ...
- **Location:** EN: ... / KO: ...
- **Category:** ...
```

### 5. Report to user

Summarize: N ads found, M slides extracted, voice memo duration, regen image count. Ask if they want to push to Sanity (-> trigger `/church-ads:push-to-sanity`).

## Categories (Sanity refs)

Map ads to existing category keys when generating segments.json:
- `college` / 대학부
- `youngAdult` / 청년부
- `adult` / 장년부
- `newcomer` / 새가족
- `specialEvents` / 특별 행사
- `general` / 전체

## Gotchas

- **Voice Memo filename has space**: `YYYYMMDD HHMMSS.m4a` — quote paths everywhere.
- **macOS Unicode in old screenshots** (` ` narrow no-break space): irrelevant for PDF flow but watch out if user mixes inputs.
- **Multi-page ads** rare but real — segmentation must consult both transcript and visual page content. Allow 1 ad to span 2 pages.
- **Korean translation** needs church-appropriate vocabulary (예배/말씀/교제 etc.) — Gemini prompt should specify Korean-American bilingual congregation context.
- **Regen prompts** must instruct: "preserve all factual info — dates, times, locations, fees, URLs". Hallucinated details corrupt output. Each language gets its own prompt (en/ko).
- **Language purity in images**: stronger-prompt wrapper is applied by `regen-images.ts` (CRITICAL: no English in KO slides; no Korean in EN slides). Without this, Gemini tends to mix languages.
- **Hero exclusivity**: `primary=true` on at most one ad. If user has not specified, default all to `primary=false`.
- **Existing CLAUDE.md**: project at `/Users/temporary/lab/church/ccs-events-seattle-clone` — read for `Event` schema, Sanity creds, hero rules.
