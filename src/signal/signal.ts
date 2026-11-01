import type { Evidence } from '../story';

export const MODEL_LABEL = 'Gemma 4 E2B (onnx-community/gemma-4-E2B-it-ONNX)';
export const NO_SIGNAL = 'NO SIGNAL ON THAT BAND.';

export type Mode = 'off' | 'loading' | 'ready' | 'generating' | 'error' | 'scripted';

// ------------------------------------------------------------------ capability check

export async function checkWebGPU(): Promise<{ ok: boolean; reason: string; fp16?: boolean }> {
  const gpu = (navigator as any).gpu;
  if (!window.isSecureContext) return { ok: false, reason: 'Page is not a secure context (needs https or localhost).' };
  if (!gpu) return { ok: false, reason: 'navigator.gpu is missing — this browser has no WebGPU.' };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: 'WebGPU exists but no GPU adapter was granted.' };
    return { ok: true, reason: 'WebGPU adapter available.', fp16: adapter.features.has('shader-f16') };
  } catch (e) {
    return { ok: false, reason: `WebGPU adapter request failed: ${String(e)}` };
  }
}

// ------------------------------------------------------------------ prompt

function describe(e: Evidence) {
  const tc = (e as Evidence & { timecode?: string }).timecode;
  return `${e.title}${tc ? ` [timecode ${tc}]` : ''}: ${e.text}`;
}

export function buildMessages(question: string, evidence: Evidence[]) {
  const list = evidence.map((e) => `[${e.id}] (${e.source}) ${describe(e)}`).join('\n');
  const system = [
    'You are THE SIGNAL, a faint voice in the static of an abandoned radio observatory, helping an investigator reason about evidence.',
    'You know ONLY the evidence listed below. Rules:',
    '1. End every sentence with the evidence reference(s) it relies on, in square brackets, e.g. [E1] or [F2].',
    '2. Use only facts stated in the evidence. Never invent names, dates, numbers, places or events.',
    `3. If the evidence cannot answer the question, reply exactly: ${NO_SIGNAL}`,
    '4. Do not declare the final order of the fragments; you may point out their timecodes.',
    '5. At most 4 short sentences. Terse, like a night radio operator.',
    '',
    'EVIDENCE:',
    list || '(none discovered yet)',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: question },
  ];
}

// ------------------------------------------------------------------ validation

export interface CheckedSentence {
  text: string;
  cites: string[];
  ok: boolean;
  reason?: string;
}

export interface Verdict {
  sentences: CheckedSentence[];
  status: 'verified' | 'partial' | 'rejected' | 'no-signal';
}

const CITE_RE = /\[([A-Z]\d+(?:\s*[,;]\s*[A-Z]?\d+)*)\]/g;
const WORD_WHITELIST = new Set(['I', 'THE', 'SIGNAL', 'NO', 'ON', 'THAT', 'BAND', 'MHz', 'TX', 'CH', 'T', 'AM']);

/**
 * Checks a model answer against discovered evidence. Each sentence must cite discovered
 * evidence, and any number or proper noun it uses must occur in the cited/discovered text.
 */
export function validate(raw: string, evidence: Evidence[]): Verdict {
  const text = raw
    .replace(/<\|channel>thought[\s\S]*?<channel\|>/g, '')
    .replace(/\*\*/g, '')
    .trim();
  if (!text) return { sentences: [], status: 'rejected' };
  if (text.toUpperCase().includes('NO SIGNAL ON THAT BAND')) {
    return { sentences: [{ text: NO_SIGNAL, cites: [], ok: true }], status: 'no-signal' };
  }

  const known = new Map(evidence.map((e) => [e.id, e]));
  const corpus = evidence.map(describe).join(' ').toLowerCase();

  // move trailing citations inside the sentence: "foo. [E1]" -> "foo [E1]."
  const normalized = text.replace(/([.!?])\s*((?:\[[^\]]+\]\s*,?\s*)+)/g, ' $2$1 ');
  const parts = normalized
    .split(/(?<=[.!?])(?<!\b[A-Z]\.)\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);

  const sentences: CheckedSentence[] = parts.map((s) => {
    const cites: string[] = [];
    for (const m of s.matchAll(CITE_RE)) {
      let prefix = '';
      m[1].split(/[,;]/).forEach((raw) => {
        let id = raw.trim();
        if (/^[A-Z]/.test(id)) prefix = id[0];
        else id = prefix + id;
        cites.push(id);
      });
    }
    const bare = s.replace(CITE_RE, '').replace(/\s+([.!?,])/g, '$1').trim();
    if (!cites.length) return { text: bare, cites, ok: false, reason: 'no evidence reference' };
    const unknown = cites.filter((c) => !known.has(c));
    if (unknown.length) return { text: bare, cites, ok: false, reason: `cites undiscovered evidence ${unknown.join(', ')}` };

    const cited = cites.map((c) => describe(known.get(c)!)).join(' ').toLowerCase();
    const numbers = bare.match(/\d+(?:[.:]\d+)?/g) ?? [];
    const badNum = numbers.find((n) => !cited.includes(n.toLowerCase()));
    if (badNum) return { text: bare, cites, ok: false, reason: `"${badNum}" is not in the cited evidence` };

    const words = bare.split(/\s+/).slice(1);
    const badName = words
      .map((w) => w.replace(/['’]s\b/, '').replace(/[^A-Za-z0-9-]/g, ''))
      .find((w) => /^[A-Z][a-z]{2,}/.test(w) && !WORD_WHITELIST.has(w) && !corpus.includes(w.toLowerCase()));
    if (badName) return { text: bare, cites, ok: false, reason: `"${badName}" does not appear in any evidence` };

    return { text: bare, cites, ok: true };
  });

  const okCount = sentences.filter((s) => s.ok).length;
  const status = okCount === 0 ? 'rejected' : okCount === sentences.length ? 'verified' : 'partial';
  return { sentences, status };
}

// ------------------------------------------------------------------ scripted preview

/**
 * Rule-based stand-in used when WebGPU or the model is unavailable. It only ever
 * stitches together sentences from discovered evidence; it is NOT an LLM.
 */
export function scriptedAnswer(question: string, evidence: Evidence[]): string {
  const q = question.toLowerCase();
  const has = (id: string) => evidence.find((e) => e.id === id);
  const out: string[] = [];
  const add = (id: string, sentence: string) => {
    if (has(id) && out.length < 4) out.push(`${sentence} [${id}]`);
  };

  if (/(order|sequence|reconstruct|arrange|fragment|final)/.test(q)) {
    const frags = evidence.filter((e) => e.kind === 'fragment') as (Evidence & { timecode?: string })[];
    frags.forEach((f) => add(f.id, `${f.title} carries timecode ${f.timecode}.`));
    if (frags.length) out.push(`Timecodes are on the record; the arrangement is yours to make [${frags[0].id}].`);
  }
  if (/(freq|tune|dial|mhz|transmitter|tx)/.test(q)) {
    add('E1', 'The logged carrier sat on 7.317 MHz.');
    add('E5', 'TX-2 was left with its dial at 7.317 MHz.');
  }
  if (/(okafor|operator|who|missing|she|voice)/.test(q)) {
    add('E2', 'The voice in the carrier was the operator\'s own, reading the log entry before it was written.');
    add('E3', 'Night operator M. Okafor was reported missing after the 14 March shift.');
  }
  if (/(where|origin|source|from|inside|dish|sky)/.test(q)) {
    add('E1', 'The direction finder gave a bearing from inside the facility, not from the dish.');
    add('E4', 'The monitor traces the origin to local transmitter TX-2.');
  }
  if (/(time|17|03|minute|before|when)/.test(q)) {
    add('E4', 'The signal is received 17 minutes before it is transmitted.');
    add('E5', 'TX-2 was last keyed at 03:34.');
  }
  if (/(band|filter|channel 2|ch2)/.test(q)) add('E2', 'The operator routed the signal monitor to filter band 2.');

  if (!out.length) return NO_SIGNAL;
  return out.join(' ');
}

// ------------------------------------------------------------------ worker client

export interface ClientEvents {
  onMode: (m: Mode) => void;
  onStatus: (text: string) => void;
  onProgress: (pct: number, loaded: number, total: number) => void;
}

export class SignalClient {
  mode: Mode = 'off';
  dtype = '';
  lastTps = 0;
  private worker: Worker | null = null;
  private reqId = 0;
  private pending = new Map<number, { onToken: (t: string) => void; resolve: (s: string) => void; reject: (e: Error) => void; buf: string }>();
  private loadWaiters: { resolve: () => void; reject: (e: Error) => void } | null = null;

  private ev: ClientEvents;

  constructor(ev: ClientEvents) {
    this.ev = ev;
  }

  private setMode(m: Mode) {
    this.mode = m;
    this.ev.onMode(m);
  }

  useScripted() {
    this.setMode('scripted');
  }

  load(): Promise<void> {
    if (this.worker) return Promise.resolve();
    this.setMode('loading');
    this.worker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.handle(e.data);
    this.worker.onerror = (e) => this.fail(e.message || 'Worker crashed while loading the model.');
    this.worker.postMessage({ type: 'load' });
    return new Promise((resolve, reject) => (this.loadWaiters = { resolve, reject }));
  }

  private fail(text: string) {
    this.ev.onStatus(`ERROR: ${text}`);
    this.setMode('error');
    this.loadWaiters?.reject(new Error(text));
    this.loadWaiters = null;
    this.pending.forEach((p) => p.reject(new Error(text)));
    this.pending.clear();
  }

  private handle(m: any) {
    switch (m.type) {
      case 'status':
        this.ev.onStatus(m.text);
        break;
      case 'progress':
        this.ev.onProgress(m.progress, m.loaded, m.total);
        break;
      case 'ready':
        this.dtype = m.dtype;
        this.ev.onStatus(`Gemma 4 E2B loaded on WebGPU (${m.dtype}). Local inference ready.`);
        this.setMode('ready');
        this.loadWaiters?.resolve();
        this.loadWaiters = null;
        break;
      case 'token': {
        const p = this.pending.get(m.id);
        if (p) {
          p.buf += m.text;
          p.onToken(p.buf);
        }
        break;
      }
      case 'done': {
        const p = this.pending.get(m.id);
        this.lastTps = m.tps;
        if (p) {
          this.pending.delete(m.id);
          p.resolve(p.buf);
        }
        this.setMode('ready');
        break;
      }
      case 'error':
        if (m.id !== undefined && this.pending.has(m.id)) {
          this.pending.get(m.id)!.reject(new Error(m.text));
          this.pending.delete(m.id);
          this.ev.onStatus(`ERROR during inference: ${m.text}`);
          this.setMode('ready');
        } else {
          this.fail(m.text);
        }
        break;
    }
  }

  ask(question: string, evidence: Evidence[], onToken: (sofar: string) => void): Promise<string> {
    if (!this.worker || this.mode !== 'ready') return Promise.reject(new Error('Model is not ready.'));
    const id = ++this.reqId;
    this.setMode('generating');
    return new Promise((resolve, reject) => {
      this.pending.set(id, { onToken, resolve, reject, buf: '' });
      this.worker!.postMessage({ type: 'generate', id, messages: buildMessages(question, evidence), maxTokens: 200 });
    });
  }

  stop() {
    this.worker?.postMessage({ type: 'stop' });
  }
}
