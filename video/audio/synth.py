# Synthesised, royalty-free sound design: an ambient music bed and a handful of UI cues.
import numpy as np, wave, math
from pathlib import Path
SR = 48000
out = Path(__file__).resolve().parent.parent / "public" / "sfx"; out.mkdir(parents=True, exist_ok=True)

def write(name, x):
    x = np.clip(x, -1, 1); d = (x * 32767).astype("<i2")
    with wave.open(str(out / name), "wb") as w:
        w.setnchannels(2 if d.ndim == 2 else 1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(d.tobytes())
    print(name, f"{len(x)/SR:.1f}s")

def env(n, a, r):  # linear attack / exponential release
    e = np.ones(n); ai = int(a * SR); e[:ai] = np.linspace(0, 1, ai); e[ai:] *= np.exp(-np.linspace(0, r, n - ai)); return e

def tone(freq, n, harm=(1, .35, .15, .07), detune=0.0):
    t = np.arange(n) / SR; x = np.zeros(n)
    for i, a in enumerate(harm):
        x += a * np.sin(2 * math.pi * freq * (i + 1) * (1 + detune) * t)
    return x / sum(harm)

# --- music: D minor pad progression, 200 s, slow and warm ---------------------------
def music(seconds=200, bpm=84):
    n = int(seconds * SR); t = np.arange(n) / SR
    chords = [  # Dm, Bb, F, C — root positions in Hz (D3 = 146.83)
        [146.83, 174.61, 220.00, 293.66], [116.54, 146.83, 174.61, 233.08], [174.61, 220.00, 261.63, 349.23], [130.81, 164.81, 196.00, 261.63]]
    bar = 60 / bpm * 8  # one chord per 8 beats
    L = np.zeros(n); R = np.zeros(n)
    for ci in range(int(seconds / bar) + 1):
        ch = chords[ci % 4]; s0 = int(ci * bar * SR); s1 = min(n, int((ci + 1.15) * bar * SR)); m = s1 - s0
        if m <= 0: continue
        e = env(m, 1.6, 2.2)
        for k, fr in enumerate(ch):
            v = tone(fr, m, detune=0.0015) * 0.5 + tone(fr, m, detune=-0.0015) * 0.5
            L[s0:s1] += v * e * (0.22 if k else 0.3) * (1 + 0.2 * math.sin(k))
            R[s0:s1] += tone(fr, m, detune=0.001) * e * (0.22 if k else 0.3) * (1 + 0.2 * math.cos(k))
    # a soft pulse, every beat, very low in the mix
    beat = int(60 / bpm * SR); p = np.zeros(n)
    for b in range(0, n, beat):
        m = min(n - b, int(0.28 * SR)); p[b:b + m] += np.sin(2 * math.pi * 55 * np.arange(m) / SR) * env(m, 0.004, 9)
    L += p * 0.10; R += p * 0.10
    # gentle air
    rng = np.random.default_rng(3); air = rng.normal(0, 1, n)
    air = np.convolve(air, np.ones(400) / 400, "same") * (0.5 + 0.5 * np.sin(2 * math.pi * 0.05 * t))
    L += air * 0.03; R += air * 0.03
    x = np.stack([L, R], 1); x /= np.abs(x).max(); x *= 0.5
    fade = int(3 * SR); x[:fade] *= np.linspace(0, 1, fade)[:, None]; x[-fade:] *= np.linspace(1, 0, fade)[:, None]
    write("music.wav", x)

def whoosh():
    n = int(0.55 * SR); t = np.arange(n) / SR; rng = np.random.default_rng(1)
    x = rng.normal(0, 1, n)
    # sweep a moving-average "filter" from dark to bright to dark
    k = (np.sin(math.pi * t / t[-1]) * 60 + 6).astype(int); y = np.zeros(n); c = np.cumsum(np.insert(x, 0, 0))
    for i in range(n):
        w = k[i]; a = max(0, i - w); y[i] = (c[i + 1] - c[a]) / (i + 1 - a)
    y *= np.sin(math.pi * t / t[-1]) ** 1.5; write("whoosh.wav", y / np.abs(y).max() * 0.7)

def click():
    n = int(0.05 * SR); x = np.sin(2 * math.pi * 1800 * np.arange(n) / SR) * env(n, 0.001, 40); write("click.wav", x * 0.6)

def tick():
    n = int(0.12 * SR); x = tone(880, n, (1, .2)) * env(n, 0.003, 30); write("tick.wav", x * 0.5)

def success():
    n = int(1.4 * SR); x = np.zeros(n)
    for i, fr in enumerate([659.25, 880.0, 1318.5]):
        s = int(i * 0.11 * SR); m = n - s; x[s:] += tone(fr, m, (1, .3, .1)) * env(m, 0.004, 5) * (0.6 - i * 0.12)
    write("success.wav", x / np.abs(x).max() * 0.7)

def reveal():
    n = int(1.6 * SR); t = np.arange(n) / SR
    x = (tone(146.83, n) + tone(220, n) + tone(293.66, n, detune=0.002)) / 3 * (t / t[-1]) ** 2 * np.exp(-((t - 1.1) ** 2) / 0.35)
    rng = np.random.default_rng(2); x += np.convolve(rng.normal(0, 1, n), np.ones(30) / 30, "same") * 0.05 * (t / t[-1]) ** 3
    write("reveal.wav", x / np.abs(x).max() * 0.7)

music(); whoosh(); click(); tick(); success(); reveal()
