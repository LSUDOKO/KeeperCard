# Writes out/keepercard-demo.srt from the voice word timings and the scene timeline, using
# the same chunking as the on-screen captions (src/lib/Captions.tsx).
import json, re
from pathlib import Path
root = Path(__file__).resolve().parent.parent
FPS = 30
LEAD = {"problem":0.6,"meet":0.9,"card":0.4,"payment":0.4,"keeperhub":0.4,"proof":0.4,"features":0.3,"architecture":0.5,"close":0.5}
TAIL = {"problem":0.6,"meet":0.8,"card":0.6,"payment":0.8,"keeperhub":0.6,"proof":0.6,"features":0.6,"architecture":0.6,"close":3.5}

def chunks(words):
    out, cur = [], []
    def flush():
        if cur: out.append(list(cur)); cur.clear()
    end_soon = lambda i: any(re.search(r"[.!?:—]$", x["w"]) for x in words[i + 1:i + 4])
    for i, w in enumerate(words):
        cur.append(w)
        if re.search(r"[.!?:—]$", w["w"]) or (len(cur) >= 7 and re.search(r"[,;]$", w["w"])) or (len(cur) >= 9 and not end_soon(i)) or len(cur) >= 12: flush()
    flush(); return out

def ts(s):
    h, s = divmod(s, 3600); m, s = divmod(s, 60)
    return f"{int(h):02d}:{int(m):02d}:{int(s):02d},{int(round((s % 1) * 1000)):03d}"

cursor = 0.0; n = 0; lines = []
for name in LEAD:
    v = json.loads((root / "public/voice" / f"{name}.json").read_text())
    lead = round(LEAD[name] * FPS) / FPS
    last = v["words"][-1]; end = last["t"] + last["d"]
    cs = chunks(v["words"])
    for i, c in enumerate(cs):
        n += 1
        a = cursor + lead + c[0]["t"]; b = cursor + lead + c[-1]["t"] + c[-1]["d"] + 0.25
        if i + 1 < len(cs): b = min(b, cursor + lead + cs[i + 1][0]["t"] - 0.02)
        lines += [str(n), f"{ts(a)} --> {ts(b)}", " ".join(w["w"] for w in c), ""]
    cursor += lead + round((end + TAIL[name]) * FPS) / FPS
(root / "out").mkdir(exist_ok=True)
(root / "out/keepercard-demo.srt").write_text("\n".join(lines))
print(n, "captions,", f"{cursor:.1f}s")
