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
REPO=/Users/temporary/lab/church/ccs-events-seattle-clone   # HARDCODE the repo root — see below
RAW_DIR="$REPO/.church-ads.raw/${DATE}.church-ads"
PDF="$RAW_DIR/church-ads-${DATE}.pdf"
VM_DIR="$HOME/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings"
VOICE=$(ls "$VM_DIR"/${DATE}*.m4a 2>/dev/null | head -1)
```

If PDF or voice missing -> stop, ask user.

**Multiple voice memos same day:** if `ls` returns more than one `.m4a`, DON'T blindly take the first. Check durations (`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 FILE`) and pick the long one — a short (<30s) file is a false-start recording.

### 2. Run the pipeline script

```bash
export PATH="$HOME/.local/share/mise/installs/bun/latest/bin:/opt/homebrew/bin:$PATH"
bun run ${CLAUDE_PLUGIN_ROOT}/scripts/process-ads.ts \
  --date "$DATE" \
  --pdf "$PDF" \
  --voice "$VOICE" \
  --out "$RAW_DIR"
```

**IMPORTANT — use HARDCODED absolute paths, NOT `$(pwd)`.** All of `--pdf`, `--voice`, `--out` must be absolute and anchored to the hardcoded `$REPO` (as above). Do NOT build them from `$(pwd)`: earlier steps in a session (e.g. Sanity verification) leave the shell's cwd inside `studio/`, so `$(pwd)/...` resolves to the wrong directory and `pdftoppm` fails with "No such file". Relative paths also break `regen-images.ts` (its `resolve()` depends on cwd at runtime).

The script:
- Loads creds from `~/.config/.env.d` (`OPENAI_API_KEY`, `GEMINI_API_KEY`)
- Extracts PDF pages via `pdftoppm` (must be on PATH)
- Zero-pads page filenames (`page-01.png`, `page-02.png`, ...) for consistency with regen
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
- **NO QR CODES in regenerated images** (policy, enforced by `regen-images.ts` `strictPrompt` wrapper): Gemini-regenerated QR codes LOOK correct but are QR-shaped noise, not a valid matrix — confirmed with `zbarimg`, which reads the real source QRs fine and finds nothing in any regenerated one. A broken QR is worse than none. The wrapper instructs Gemini to OMIT all QR codes and leave clean background. The real sign-up URL belongs in the event's `links[]` instead, which the frontend `EventDialog.svelte` renders as clickable buttons (web visitors click, they never scan an on-screen image). If a per-ad `regen_prompt` in `segments.json` still says "include a QR code" (the segment step often does), STRIP that clause from the prompt before regen so it doesn't fight the wrapper.
- **Decode every QR BEFORE segmenting — with `decode-qr.sh`, never jsQR.** Run this first and keep the output next to you while reviewing `segments.json`:
  ```bash
  export PATH="/opt/homebrew/bin:$PATH"   # zbarimg lives here
  ~/.claude/plugins/marketplaces/won-plugins/plugins/church-ads/scripts/decode-qr.sh \
    "$RAW_DIR"        # prints  page,url  for every page that carries a QR
  ```
  **Use `zbarimg` (what the script wraps). Do NOT use jsQR** — jsQR cannot read photographed or projected slides, which is every slide in this pipeline. Measured 2026-08-09 on one week's 5 QR codes: **zbarimg 5/5** in 0.26s at plain 150 dpi with no preprocessing; **jsQR 0/5** even at 600 dpi with tiling, inversion, thresholding and 1x/2x/4x scaling (it also hangs for minutes per attempt). OpenCV `QRCodeDetector` is a weak fallback only — 2/5 on the same set — so a zbar miss is not confirmed by an OpenCV miss.
- **Segment step HALLUCINATES sign-up URLs**, so the decoded `page,url` table is the source of truth for `links[]`. Gemini invents plausible-but-fake links when a slide shows a QR but no text URL: seen as `https://forms.gle/sonlight-summer-volunteer`, `https://forms.gle/newcomers-dinner`, and `https://moli.seattlehyungje.org` (a domain that does not resolve at all). Replace the invented URL in `segments.json` `links[]` with the decoded one, then re-emit MDs with `rewrite-mds.ts`. Verify each decoded URL resolves and that its page `<title>` matches the ad — a live 200 on the wrong form is still wrong.
- **"Same URL on two ads" is a hallucination tell only for UNRELATED ads.** It fires legitimately when one ad spans several pages (e.g. a slide plus a full-page close-up of its QR), so check `page_indices` before treating a repeat as fabricated. The real signal is the same URL on ads with nothing to do with each other — `https://www.khpc.org` once landed on both a volunteer call and a mothers' program.
- **When a decode genuinely fails, leave `links[]` EMPTY.** Never write a placeholder. `https://example.com/teacher-recruit` and `.../teamrecruit` shipped to production this way and rendered as dead "Sign Up" buttons; because a placeholder looks deliberate in a database dump, nobody noticed, and two working registration forms stayed unreachable for weeks until a zbar re-scan recovered them. An absent button beats a broken one. Also check the decoded value is a real destination: the 2026-08-02 giving slide decodes to `canva.com`, a leftover template artifact, not the church's giving link.
- **`scripts/audit-qr-codes.ts` still uses jsQR and undercounts badly** — its `QR_AUDIT.md` reports 8 hits across 54 images, while zbar finds 19 across 46 extracted pages. Don't trust that file; re-scan with `decode-qr.sh`.
- **Hero exclusivity**: `primary=true` on at most one ad. If user has not specified, default all to `primary=false`.
- **Run scripts from the marketplace source**, not the install cache: `~/.claude/plugins/marketplaces/won-plugins/plugins/church-ads/scripts/` — the cache copy (`~/.claude/plugins/cache/...`) can lag behind committed fixes.
- **`bun` not on PATH** in fresh shells (mise not initialized): prefix every run with `export PATH="$HOME/.local/share/mise/installs/bun/latest/bin:/opt/homebrew/bin:$PATH"`.
- **Existing CLAUDE.md**: project at `/Users/temporary/lab/church/ccs-events-seattle-clone` — read for `Event` schema, Sanity creds, hero rules.
