// The picture is cut to the voice: each scene lasts as long as its narration plus a tail.
import problem from "../public/voice/problem.json";
import meet from "../public/voice/meet.json";
import card from "../public/voice/card.json";
import payment from "../public/voice/payment.json";
import keeperhub from "../public/voice/keeperhub.json";
import proof from "../public/voice/proof.json";
import features from "../public/voice/features.json";
import architecture from "../public/voice/architecture.json";
import close from "../public/voice/close.json";

export const FPS = 30;
export type Word = { t: number; d: number; w: string };
export type Voice = { text: string; words: Word[] };

const VOICES: Record<string, Voice> = { problem, meet, card, payment, keeperhub, proof, features, architecture, close };
// seconds of picture before the voice starts, and after it ends
const LEAD: Record<string, number> = { problem: 0.6, meet: 0.9, card: 0.4, payment: 0.4, keeperhub: 0.4, proof: 0.4, features: 0.3, architecture: 0.5, close: 0.5 };
const TAIL: Record<string, number> = { problem: 0.6, meet: 0.8, card: 0.6, payment: 0.8, keeperhub: 0.6, proof: 0.6, features: 0.6, architecture: 0.6, close: 3.5 };

export const voiceEnd = (v: Voice) => { const l = v.words[v.words.length - 1]; return l.t + l.d; };

export type Scene = { name: keyof typeof VOICES; from: number; frames: number; lead: number; voice: Voice };
export const SCENES: Scene[] = [];
let cursor = 0;
for (const name of Object.keys(VOICES) as (keyof typeof VOICES)[]) {
  const voice = VOICES[name];
  const lead = Math.round(LEAD[name] * FPS);
  const frames = lead + Math.round((voiceEnd(voice) + TAIL[name]) * FPS);
  SCENES.push({ name, from: cursor, frames, lead, voice });
  cursor += frames;
}
export const TOTAL_FRAMES = cursor;
export const scene = (name: Scene["name"]) => SCENES.find((s) => s.name === name)!;
