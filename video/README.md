# KeeperCard demo video

A ~3:20 product demo of KeeperCard, built on KeeperHub. Everything in the demo sections is
real footage of the live product and a real payment made during recording; nothing is
mocked. Source for the whole thing is in this folder.

| Deliverable | Where |
|---|---|
| Final video, 1920×1080 · 30 fps · H.264 + AAC | `out/keepercard-demo.mp4` (not committed — render it, see below) |
| Subtitles, synchronized to the narration | `out/keepercard-demo.srt` |
| Storyboard / timeline | [`STORYBOARD.md`](STORYBOARD.md) |
| Voice-over script | [`SCRIPT.md`](SCRIPT.md) |
| Video source (Remotion, React) | `src/` — one file per scene in `src/scenes/` |
| Assets | `public/` — voice (`voice/`), synthesized music + SFX (`sfx/`), fonts, screenshots |
| Recording tooling | `record/` — screen recorder, cursor overlay, the on-camera agent script |

## How it was made

- **Footage**: the live dashboard, app.keeperhub.com and Blockscout, driven in a real Chrome
  session and captured with `wf-recorder` at 60 fps (`record/rec.sh`). Chrome's own UI is
  cropped out in post. The Claude Code session is a real terminal (`kitty`) running
  `claude --mcp-config keepercard.mcp.json` against the card's production MCP endpoint;
  the prompts were sent to it live. The card secret is blurred on-page before capture.
- **Motion design**: [Remotion](https://remotion.dev). `src/timeline.ts` derives every scene's
  length from its narration, so the picture is always cut to the voice.
- **Voice**: Microsoft neural TTS via `edge-tts` (`en-US-AndrewNeural`), one file per scene,
  with word-level timings (`public/voice/*.json`) that drive the captions.
- **Captions**: rendered into the video from those timings, and exported as SRT by
  `audio/captions.py` with identical chunking.
- **Sound**: the music bed and all UI cues are synthesized by `audio/synth.py` (numpy),
  so nothing here is licensed from anyone.

## Reproduce the render

Requirements: bun (or npm), Python 3, ffmpeg, a Chromium binary for Remotion.

```bash
cd video
bun install
python3 -m venv .venv && .venv/bin/pip install edge-tts numpy

.venv/bin/python audio/voice.py      # narration + word timings → public/voice/
.venv/bin/python audio/synth.py      # music + sfx → public/sfx/
.venv/bin/python audio/captions.py   # → out/keepercard-demo.srt

# footage/ is not committed (it contains a live session). Re-record with record/rec.sh, or
# drop the clips listed in src/scenes/*.tsx into footage/ (public/footage links there).

bun run render                        # → out/keepercard-demo.mp4 (≈12 min at concurrency 2)
ffmpeg -i out/keepercard-demo.mp4 -c:v copy -af volume=3.3dB -c:a aac -b:a 192k -movflags +faststart out/final.mp4   # −17 LUFS, peaks −1.6 dBFS
# or: npx remotion render src/index.ts Demo out/keepercard-demo.mp4 --concurrency 2
```

`bun run preview` opens Remotion Studio for scrubbing the timeline.

## Footage clips referenced

| Clip | Content |
|---|---|
| `landing.mp4` | Landing page, hero and "how a payment works" |
| `card.mp4` | A real card: terms tab, activity, Connect Agent (URL blurred) |
| `agent.mp4` | Claude Code: card check → dry run → pay → receipt → over-limit refusal |
| `kh-run.mp4` | KeeperHub: `card-payment-redemption`, Run #5 expanded, gas sponsored |
| `kh-analytics.mp4` | KeeperHub Analytics: run table with payment → receipt → event watcher |
| `console.mp4` | KeeperCard execution console: status, treasury, executions, receipts |
| `explorer.mp4` | Blockscout: the payment transaction, two USDC transfers |
| `guarded.mp4` | KeeperHub: `guarded-card-payment` canvas with the Condition node |
| `treasury.mp4` | KeeperHub: `treasury-monitor`, run #50, ten-minute schedule |
| `freeze.mp4` | Dashboard: Freeze → frozen card → Unfreeze → Sub-Cards |

## What the video does not claim

Mainnet, x402 / fiat settlement runs, or a risk *refusal* by KeeperHub's assessor — none of
those have happened, so none are shown.
