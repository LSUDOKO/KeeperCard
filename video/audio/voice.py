# Reads SCRIPT.md, synthesises one MP3 per "## NN · name" block with edge-tts, and writes
# public/voice/<name>.json with the word timings (for captions) and the duration.
import asyncio, json, re, sys
from pathlib import Path
import edge_tts

VOICE = "en-US-AndrewNeural"
RATE = "-4%"
root = Path(__file__).resolve().parent.parent
blocks = re.findall(r"^## \d+ · (\w+)\n(.*?)(?=^## |\Z)", (root / "SCRIPT.md").read_text(), re.S | re.M)

async def one(name, text):
    text = " ".join(l.strip() for l in text.strip().splitlines() if l.strip())
    out = root / "public" / "voice" / name
    words, audio = [], bytearray()
    async for ev in edge_tts.Communicate(text, VOICE, rate=RATE, boundary="WordBoundary").stream():
        if ev["type"] == "audio":
            audio += ev["data"]
        elif ev["type"] == "WordBoundary":
            words.append({"t": ev["offset"] / 1e7, "d": ev["duration"] / 1e7, "w": ev["text"]})
    # edge-tts strips punctuation from word events; put it back from the script text so
    # captions can break at sentence boundaries
    tokens = text.split(" "); ti = 0
    strip = lambda w: "".join(ch for ch in w.lower() if ch.isalnum())
    for w in words:
        core = strip(w["w"])
        for look in range(ti, min(ti + 3, len(tokens))):
            if strip(tokens[look]).startswith(core) or core.startswith(strip(tokens[look])):
                w["w"] = tokens[look]; ti = look + 1; break
    out.with_suffix(".mp3").write_bytes(audio)
    out.with_suffix(".json").write_text(json.dumps({"text": text, "words": words}))
    print(f"{name:12s} {len(words):3d} words  {words[-1]['t'] + words[-1]['d']:.1f}s")

async def main():
    for name, text in blocks:
        await one(name, text)

asyncio.run(main())
