import { FACTS, type Evidence } from './story';
import { describePhase, type LoadSnapshot } from './signal/progress';
import { MODEL_LABEL, SignalClient, checkWebGPU, lookupFact, scriptedAnswer, validate, type Mode, type Verdict } from './signal/signal';

const gb = (bytes: number) => (bytes / 1e9).toFixed(2);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

interface Entry {
  q: string;
  source: 'model' | 'scripted' | 'lookup';
  streaming: string;
  raw?: string;
  /** For lookups: the evidence item the answer was taken from. */
  sourceEvidence?: Evidence;
  verdict?: Verdict;
  meta?: string;
  error?: string;
}

const SUGGESTIONS = [
  'Where is the carrier coming from?',
  'What frequency should TX-2 be on?',
  'Which filter band did the operator use?',
  'How do the fragments fit together?',
  'Who was the night operator?',
];

const VERDICT_TEXT: Record<Verdict['status'], string> = {
  verified: 'VERIFIED · every claim cites discovered evidence',
  partial: 'PARTIAL · unsupported claims struck out',
  rejected: 'REJECTED · no evidence-backed claims',
  'no-signal': 'NO SIGNAL · evidence does not answer this',
};

export function initSignalPanel(root: HTMLElement, modeEl: HTMLElement, badgeEl: HTMLElement, getEvidence: () => Evidence[]) {
  const entries: Entry[] = [];
  let gpu: { ok: boolean; reason: string; fp16?: boolean } | null = null;
  let statusText = '';
  let snap: LoadSnapshot | null = null;
  let usedModel = false;
  let usedScripted = false;
  let usedLookup = false;

  const client = new SignalClient({
    onMode: () => render(),
    onStatus: (t) => {
      statusText = t;
      const el = root.querySelector('#sig-status');
      if (el) el.textContent = t;
      else render();
    },
    onProgress: (s) => {
      snap = s;
      const bar = root.querySelector<HTMLElement>('#sig-bar');
      if (bar) {
        bar.style.width = `${s.percent}%`;
        root.querySelector('#sig-bytes')!.textContent = bytesLine();
        root.querySelector('#sig-status')!.textContent = describePhase(s);
      }
      updateBadges(client.mode);
    },
  });

  checkWebGPU().then((r) => {
    gpu = r;
    render();
  });

  function bytesLine() {
    if (!snap || snap.phase === 'resolving') return '0.0%';
    return `${snap.percent.toFixed(1)}% · ${gb(snap.loaded)} / ${gb(snap.total)} GB`;
  }

  function updateBadges(mode: Mode) {
    const labels: Record<Mode, string> = {
      off: 'OFFLINE',
      loading: `LOADING ${Math.floor(snap?.percent ?? 0)}%`,
      ready: 'GEMMA 4 E2B · LOCAL',
      generating: 'INFERRING…',
      error: 'ERROR',
      scripted: 'SCRIPTED PREVIEW',
    };
    modeEl.textContent = labels[mode];
    modeEl.className = `mode ${mode}`;
    badgeEl.textContent = labels[mode].toLowerCase();
  }

  function renderAnswer(e: Entry) {
    if (e.error) return `<div class="a"><span class="s-bad" style="text-decoration:none;color:var(--red)">Inference failed: ${esc(e.error)}</span></div>`;
    if (!e.verdict) return `<div class="a"><div class="streaming">${esc(e.streaming) || 'listening to the static…'}</div></div>`;
    const body = e.verdict.sentences
      .map((s) =>
        s.ok
          ? `<span class="s-ok">${esc(s.text)}${s.cites.map((c) => `<span class="cite">${c}</span>`).join('')}</span> `
          : `<span class="s-bad">${esc(s.text)}<span class="why">removed: ${esc(s.reason ?? 'unsupported')}</span></span> `,
      )
      .join('');
    const lookup = e.source === 'lookup';
    const details = lookup && e.sourceEvidence
      ? `<details class="context-note"><summary>source evidence</summary>[${e.sourceEvidence.id}] ${esc(e.sourceEvidence.text)}</details>`
      : `<details class="context-note"><summary>raw output</summary>${esc(e.raw ?? '')}</details>`;
    return `<div class="a${lookup ? ' lookup' : ''}">${lookup ? '<div class="src-tag">EVIDENCE LOOKUP · NOT GENERATED</div>' : ''}${body || '<span class="s-bad">(empty response)</span>'}
      <div class="verdict ${e.verdict.status}">${VERDICT_TEXT[e.verdict.status]}</div>
      <div class="context-note">${esc(e.meta ?? '')}</div>
      ${details}</div>`;
  }

  function render() {
    const mode = client.mode;
    updateBadges(mode);
    const ev = getEvidence();

    if (mode === 'off') {
      const check = gpu
        ? `<div class="sig-check ${gpu.ok ? 'ok' : 'bad'}">${gpu.ok ? '✓' : '✕'} ${esc(gpu.reason)}${gpu.ok ? ` shader-f16: ${gpu.fp16 ? 'yes (q4f16)' : 'no (q4)'}` : ''}</div>`
        : '<div class="sig-check">Checking WebGPU…</div>';
      root.innerHTML = `
        <p class="sig-intro"><strong>THE SIGNAL</strong> is an open-weights language model, <strong>${MODEL_LABEL}</strong>, running entirely in this browser tab via Transformers.js and WebGPU. It is not loaded until you ask.</p>
        <p class="sig-intro">It only ever sees the evidence you have recovered, must cite it as [E1], [F2]…, and every sentence is checked against that evidence before you see it. It cannot solve the case: the transmitter checks the final sequence itself.</p>
        ${check}
        <div class="sig-actions">
          <button class="btn-ghost" id="sig-load" ${gpu?.ok ? '' : 'disabled'}>LOAD GEMMA 4 E2B · ~3.1 GB, CACHED AFTER FIRST RUN</button>
          <button class="btn-ghost amber" id="sig-script">USE SCRIPTED PREVIEW (NO AI)</button>
        </div>
        <p class="context-note">The download comes from the Hugging Face Hub and is stored in the browser cache. No questions or evidence are sent to any server.</p>`;
      root.querySelector('#sig-load')?.addEventListener('click', () => {
        client.load().catch(() => {});
      });
      root.querySelector('#sig-script')?.addEventListener('click', () => client.useScripted());
      return;
    }

    if (mode === 'loading') {
      root.innerHTML = `
        <div class="banner local">Loading ${MODEL_LABEL} onto WebGPU. Local inference is NOT running yet.</div>
        <div class="progress"><i id="sig-bar" style="width:${snap?.percent ?? 0}%"></i></div>
        <div class="status-line" id="sig-bytes">${bytesLine()}</div>
        <div class="status-line" id="sig-status" style="margin-top:8px">${esc(snap ? describePhase(snap) : statusText || 'Starting worker…')}</div>
        <p class="context-note">You can close this panel and keep exploring while the model downloads.</p>`;
      return;
    }

    if (mode === 'error') {
      root.innerHTML = `
        <div class="sig-check bad">The local model failed to load. Local inference is NOT running.</div>
        <div class="status-line" id="sig-status">${esc(statusText)}</div>
        <div class="sig-actions" style="margin-top:14px">
          <button class="btn-ghost amber" id="sig-script">USE SCRIPTED PREVIEW (NO AI)</button>
        </div>
        <p class="context-note">Common causes: not enough GPU memory, WebGPU disabled, or the download was interrupted. Reload the page to retry.</p>`;
      root.querySelector('#sig-script')?.addEventListener('click', () => client.useScripted());
      return;
    }

    const banner = mode === 'scripted'
      ? `<div class="banner scripted">SCRIPTED PREVIEW · rule-based replies stitched from recovered evidence. No language model is running.</div>`
      : `<div class="banner local">READY · LOCAL INFERENCE · ${MODEL_LABEL} · WebGPU ${client.dtype} · ${gb(client.loadedBytes)} GB loaded in ${client.loadSeconds.toFixed(0)} s${client.lastTps ? ` · ${client.lastTps.toFixed(1)} tok/s` : ''}</div>`;
    const busy = mode === 'generating';
    root.innerHTML = `${banner}
      <div class="chat" id="sig-chat">${entries.map((e) => `<div><div class="q">${esc(e.q)}</div>${renderAnswer(e)}</div>`).join('') || '<p class="sig-intro">Ask about the evidence you have recovered.</p>'}</div>
      <div class="chips">${SUGGESTIONS.map((s) => `<button class="chip" ${busy ? 'disabled' : ''}>${esc(s)}</button>`).join('')}</div>
      <form class="ask" id="sig-form">
        <input type="text" id="sig-input" placeholder="${busy ? 'THE SIGNAL is answering…' : 'Ask THE SIGNAL…'}" autocomplete="off" ${busy ? 'disabled' : ''} />
        ${busy ? '<button type="button" class="btn-ghost amber" id="sig-stop">STOP</button>' : '<button class="btn-ghost">ASK</button>'}
      </form>
      ${mode === 'scripted' && gpu?.ok ? '<button class="chip" id="sig-upgrade" style="margin-top:10px">Load the real model instead (Gemma 4 E2B)</button>' : ''}
      <div class="context-note">Context sent: ${ev.length ? ev.map((e) => e.id).join(', ') : 'no evidence yet'} · nothing else.</div>`;

    const chat = root.querySelector('#sig-chat')!;
    chat.scrollTop = chat.scrollHeight;
    root.parentElement!.scrollTop = root.parentElement!.scrollHeight;
    root.querySelectorAll<HTMLButtonElement>('.chips .chip').forEach((b) => b.addEventListener('click', () => ask(b.textContent!)));
    root.querySelector('#sig-form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = (root.querySelector('#sig-input') as HTMLInputElement).value.trim();
      if (v) ask(v);
    });
    root.querySelector('#sig-stop')?.addEventListener('click', () => client.stop());
    root.querySelector('#sig-upgrade')?.addEventListener('click', () => client.load().catch(() => {}));
    if (!busy) (root.querySelector('#sig-input') as HTMLInputElement)?.focus();
  }

  async function ask(q: string) {
    const ev = getEvidence();
    const hit = lookupFact(q, ev, FACTS);
    if (hit) {
      usedLookup = true;
      entries.push({
        q,
        source: 'lookup',
        streaming: '',
        raw: hit.raw,
        verdict: hit.verdict,
        sourceEvidence: hit.source,
        meta: `Evidence lookup · exact fact from ${hit.source.id} (${hit.source.title}) · deterministic, no language model used for this reply`,
      });
      render();
      return;
    }
    if (client.mode === 'scripted') {
      usedScripted = true;
      const raw = scriptedAnswer(q, ev);
      entries.push({ q, source: 'scripted', streaming: '', raw, verdict: validate(raw, ev), meta: 'Scripted preview · rule-based · not AI inference' });
      render();
      return;
    }
    if (client.mode !== 'ready') return;
    usedModel = true;
    const entry: Entry = { q, source: 'model', streaming: '' };
    entries.push(entry);
    render();
    try {
      const raw = await client.ask(q, ev, (sofar) => {
        entry.streaming = sofar;
        const nodes = root.querySelectorAll('.streaming');
        const node = nodes[nodes.length - 1];
        if (node) node.textContent = sofar;
      });
      entry.raw = raw;
      entry.verdict = validate(raw, ev);
      entry.meta = `Gemma 4 E2B · local WebGPU · ${client.lastTps.toFixed(1)} tok/s · ${ev.length} evidence items in context`;
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
    }
    render();
  }

  render();
  return {
    focus: () => render(),
    summary: () =>
      usedModel
        ? 'local Gemma 4 E2B consulted'
        : usedScripted
          ? 'scripted preview only (no AI)'
          : usedLookup
            ? 'evidence lookup only (no AI)'
            : 'not consulted',
  };
}
