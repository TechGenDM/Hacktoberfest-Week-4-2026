import './style.css';
import { World, type InteractId } from './world';
import { state, STEPS } from './state';
import {
  EPILOGUE,
  EVIDENCE,
  FINAL_TRANSMISSION,
  FRAGMENTS,
  FREQ_MAX,
  FREQ_MIN,
  FREQ_TOLERANCE,
  TARGET_FREQUENCY,
  isCorrectOrder,
  type Evidence,
} from './story';
import { blip, setTuning, silence, startAudio } from './audio';
import { initSignalPanel } from './signalPanel';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const world = new World($('#app'));
const signal = initSignalPanel($('#signal-body'), $('#sig-mode'), $('#sig-badge'), () => state.evidence());

let started = false;
let ended = false;
type Overlay = 'modal' | 'evidence' | 'signal' | null;
let overlay: Overlay = null;
let station: InteractId | 'recon' | null = null;
let modalCleanup: (() => void) | null = null;
let target: InteractId | null = null;

// ------------------------------------------------------------------ pointer lock & overlays

function capture() {
  try {
    const p = world.renderer.domElement.requestPointerLock() as unknown as Promise<void> | undefined;
    p?.catch?.(() => showPause());
  } catch {
    showPause();
  }
}

function showPause() {
  if (!started || ended || overlay) return;
  $('#pause').classList.remove('hidden');
}

world.controls.addEventListener('lock', () => {
  $('#pause').classList.add('hidden');
  world.movementEnabled = true;
});
world.controls.addEventListener('unlock', () => {
  world.clearKeys();
  showPause();
});
document.addEventListener('pointerlockerror', () => showPause());

function hideOverlays() {
  modalCleanup?.();
  modalCleanup = null;
  station = null;
  ['#modal', '#evidence', '#signal'].forEach((s) => $(s).classList.add('hidden'));
}

function openOverlay(kind: Exclude<Overlay, null>) {
  hideOverlays();
  overlay = kind;
  $(kind === 'modal' ? '#modal' : `#${kind}`).classList.remove('hidden');
  $('#prompt').classList.add('hidden');
  if (document.pointerLockElement) document.exitPointerLock();
}

function closeOverlay(relock = true) {
  hideOverlays();
  overlay = null;
  if (relock && started && !ended) capture();
}

function toggle(kind: 'evidence' | 'signal') {
  if (overlay === kind) return closeOverlay();
  openOverlay(kind);
  if (kind === 'evidence') renderEvidence();
  else signal.focus();
}

document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeOverlay()));

function modal(kicker: string, title: string, html: string) {
  openOverlay('modal');
  $('#modal-kicker').textContent = kicker;
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  return $('#modal-body');
}

// ------------------------------------------------------------------ HUD

function toast(e: Evidence) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<small>${e.kind === 'fragment' ? 'SIGNAL FRAGMENT RECOVERED' : 'NEW EVIDENCE'} · ${e.id}</small>${esc(e.title)}`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 5200);
}

function discover(...ids: string[]) {
  const fresh = state.discover(...ids);
  fresh.forEach((id, i) => setTimeout(() => toast(state.evidence().find((e) => e.id === id)!), i * 350));
  if (fresh.length) blip(1320, 0.12);
}

function renderHud() {
  $('#pips').innerHTML = STEPS.map((s) => `<div class="pip ${state.done.has(s.id) ? 'on' : ''}" title="${s.label}"></div>`).join('');
  $('#hud-pct').textContent = `${Math.round(state.progress() * 100)}%`;
  $('#hud-obj').textContent = state.nextObjective();
  $('#ev-count').textContent = `${state.discovered.length}/${state.totalItems()}`;

  world.setChannel(0, state.has('F1') ? 'locked' : 'noise');
  world.setChannel(1, state.has('F2') ? 'locked' : state.done.has('log') ? 'noise' : 'blocked');
  world.setChannel(2, state.has('F3') ? 'locked' : state.done.has('tuned') ? 'noise' : 'idle');
  world.markDone('log', state.done.has('log'));
  world.markDone('monitor', state.allFragments());
  world.markDone('transmitter', state.done.has('reconstructed'));
  if (overlay === 'evidence') renderEvidence();
}
state.onChange(renderHud);
renderHud();

world.onTarget = (t) => {
  target = t?.id ?? null;
  $('#crosshair').classList.toggle('active', !!t);
  const p = $('#prompt');
  p.classList.toggle('hidden', !t || !!overlay);
  if (t) p.querySelector('span')!.textContent = t.label;
};

let clockStart = 0;
setInterval(() => {
  if (!started || ended) return;
  const s = 3 * 3600 + 17 * 60 + Math.floor((performance.now() - clockStart) / 1000);
  const f = (n: number) => String(n).padStart(2, '0');
  $('#hud-time').textContent = `${f(Math.floor(s / 3600) % 24)}:${f(Math.floor(s / 60) % 60)}:${f(s % 60)}`;
}, 250);

// ------------------------------------------------------------------ evidence drawer

function renderEvidence() {
  const groups: { title: string; ids: string[] }[] = [
    { title: 'INCIDENT LOG', ids: ['E1', 'E2', 'E3'] },
    { title: 'INSTRUMENTS', ids: ['E4', 'E5'] },
    { title: 'TRANSMISSION FRAGMENTS', ids: Object.keys(FRAGMENTS) },
  ];
  const item = (id: string) => {
    if (!state.has(id)) return `<div class="ev-missing">${id} · not yet recovered</div>`;
    const e = (EVIDENCE[id] ?? FRAGMENTS[id]) as Evidence & { timecode?: string };
    return `<div class="ev-item ${e.kind}"><span class="id">${e.id}</span><span class="t">${esc(e.title)}${e.timecode ? ` · ${e.timecode}` : ''}</span><p>${esc(e.text)}</p></div>`;
  };
  const recon = state.allFragments() && !state.done.has('reconstructed')
    ? `<button class="btn-ghost" id="ev-recon">RECONSTRUCT FINAL TRANSMISSION</button>`
    : '';
  $('#evidence-list').innerHTML =
    groups.map((g) => `<div class="ev-group"><h3>${g.title}</h3>${g.ids.map(item).join('')}</div>`).join('') + recon;
  $('#ev-recon')?.addEventListener('click', openReconstruction);
}

// ------------------------------------------------------------------ stations

function openStation(id: InteractId) {
  if (id === 'log') renderLog();
  else if (id === 'monitor') renderMonitor();
  else renderTransmitter();
}

function renderLog() {
  const body = modal('INCIDENT LOG · KESTREL RIDGE', 'Night Operations Log', `
    <div class="logbook">
      <div class="log-page"><div class="stamp">[E1] 14 MAR 1979 · 03:09</div>${esc(EVIDENCE.E1.text)}</div>
      <div class="log-page"><div class="stamp">[E2] 14 MAR 1979 · 03:17</div>${esc(EVIDENCE.E2.text)}</div>
      <div class="log-page notice"><div class="stamp">[E3] DECOMMISSION NOTICE · 02 APR 1979</div>${esc(EVIDENCE.E3.text)}</div>
    </div>`);
  station = 'log';
  void body;
  discover('E1', 'E2', 'E3');
  state.complete('log');
}

function decodeAnim(meter: HTMLElement, done: () => void) {
  const t0 = performance.now();
  const dur = 1400;
  const fill = meter.querySelector('i') as HTMLElement;
  const iv = setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / dur);
    fill.style.width = `${k * 100}%`;
    if (k >= 1) {
      clearInterval(iv);
      done();
    }
  }, 30);
  blip(660, 0.2);
}

function renderMonitor(msg = '') {
  const ch = (n: number, title: string, fragId: string, extra: string, locked: string | null) => {
    const f = FRAGMENTS[fragId];
    const got = state.has(fragId);
    return `<div class="channel">
      <div class="channel-head"><span>CH ${n} // ${title}</span><span class="st ${got ? 'ok' : ''}">${got ? 'DECODED · ' + f.timecode : locked ?? 'CARRIER PRESENT'}</span></div>
      ${got ? `<p class="quote">“${esc(f.text)}”</p>` : extra}
    </div>`;
  };
  const ch1 = ch(1, 'CARRIER', 'F1', `<div class="bands"><button class="btn-ghost" data-decode="1">DEMODULATE</button></div><div class="meter" id="m1"><i></i></div>`, null);
  const ch2 = state.done.has('log')
    ? ch(2, 'BAND FILTER', 'F2', `<p>Select a filter band to isolate the voice layer.</p><div class="bands">${[1, 2, 3, 4].map((b) => `<button class="btn-ghost amber" data-band="${b}">BAND ${b}</button>`).join('')}</div><div class="meter" id="m2"><i></i></div>`, null)
    : ch(2, 'BAND FILTER', 'F2', `<p>Voice layer buried under interference. Which filter band did the night operator use? The incident log may say.</p>`, 'FILTER BAND UNKNOWN');
  const ch3 = state.done.has('tuned')
    ? ch(3, 'TX-2 FEED', 'F3', `<div class="bands"><button class="btn-ghost" data-decode="3">CAPTURE TX-2 CARRIER</button></div><div class="meter" id="m3"><i></i></div>`, null)
    : ch(3, 'TX-2 FEED', 'F3', `<p>NO CARRIER. Transmitter TX-2 is not on the logged frequency.</p>`, 'NO CARRIER');
  const analysis = state.has('E4')
    ? `<p class="hint">[E4] ${esc(EVIDENCE.E4.text)}</p>`
    : '';
  const body = modal('SIGNAL MONITOR · 3-CHANNEL', 'Transmission Fragments', `<div class="channels">${ch1}${ch2}${ch3}</div>${analysis}<div class="msg" id="mon-msg">${esc(msg)}</div>`);
  station = 'monitor';

  body.querySelector('[data-decode="1"]')?.addEventListener('click', (e) => {
    (e.currentTarget as HTMLButtonElement).disabled = true;
    decodeAnim($('#m1'), () => {
      discover('F1', 'E4');
      state.complete('ch1');
      if (station === 'monitor') renderMonitor('Channel 1 decoded. Origin trace attached as E4.');
    });
  });
  body.querySelectorAll<HTMLButtonElement>('[data-band]').forEach((b) =>
    b.addEventListener('click', () => {
      const band = Number(b.dataset.band);
      if (band !== 2) {
        blip(180, 0.25);
        $('#mon-msg').className = 'msg bad';
        $('#mon-msg').textContent = `Band ${band}: only static.`;
        return;
      }
      body.querySelectorAll<HTMLButtonElement>('[data-band]').forEach((x) => (x.disabled = true));
      decodeAnim($('#m2'), () => {
        discover('F2');
        state.complete('ch2');
        if (station === 'monitor') renderMonitor('Band 2 isolates a voice. Fragment II recovered.');
      });
    }),
  );
  body.querySelector('[data-decode="3"]')?.addEventListener('click', (e) => {
    (e.currentTarget as HTMLButtonElement).disabled = true;
    decodeAnim($('#m3'), () => {
      discover('F3');
      state.complete('ch3');
      if (station === 'monitor') renderMonitor(state.allFragments() ? 'All fragments recovered. Reconstruct the transmission at TX-2 or from the evidence file (J).' : '');
    });
  });
}

function drawTxDial(ctx: CanvasRenderingContext2D, f: number, locked: boolean) {
  const w = ctx.canvas.width, c = w / 2;
  ctx.clearRect(0, 0, w, w);
  const g = ctx.createRadialGradient(c, c, 10, c, c, c);
  g.addColorStop(0, '#3a2c14');
  g.addColorStop(1, '#0e0b06');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(c, c, c - 2, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(232,166,90,0.5)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(c, c, c - 4, 0, Math.PI * 2); ctx.stroke();
  const a0 = Math.PI * 0.8, a1 = Math.PI * 2.2;
  const ang = (v: number) => a0 + ((v - FREQ_MIN) / (FREQ_MAX - FREQ_MIN)) * (a1 - a0);
  ctx.fillStyle = ctx.strokeStyle = '#e7b56a';
  ctx.font = '16px IBM Plex Mono, monospace';
  ctx.textAlign = 'center';
  for (let v = 3; v <= 10; v += 0.25) {
    const a = ang(v), major = Number.isInteger(v);
    ctx.lineWidth = major ? 3 : 1.5;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * (c - 18), c + Math.sin(a) * (c - 18));
    ctx.lineTo(c + Math.cos(a) * (c - (major ? 40 : 30)), c + Math.sin(a) * (c - (major ? 40 : 30)));
    ctx.stroke();
    if (major && v < 10) ctx.fillText(String(v), c + Math.cos(a) * (c - 60), c + Math.sin(a) * (c - 60) + 6);
  }
  const a = ang(f);
  ctx.strokeStyle = locked ? '#5dffa0' : '#ff6a3a';
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + Math.cos(a) * (c - 26), c + Math.sin(a) * (c - 26)); ctx.stroke();
  ctx.fillStyle = '#e7b56a';
  ctx.beginPath(); ctx.arc(c, c, 10, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(216,209,194,0.5)';
  ctx.font = '12px IBM Plex Mono, monospace';
  ctx.fillText('MHz', c, c + 70);
}

function renderTransmitter() {
  if (state.done.has('tuned')) {
    const ready = state.allFragments();
    const body = modal('TRANSMITTER TX-2', 'Carrier Locked', `
      <div class="tx-readout locked">${TARGET_FREQUENCY.toFixed(3)} <small>MHz · LOCKED</small></div>
      <p class="hint">[E5] ${esc(EVIDENCE.E5.text)}</p>
      <p class="hint">${state.has('F3') ? 'The TX-2 fragment has been captured on the monitor.' : 'TX-2 is now feeding monitor channel 3. Capture the fragment at the signal monitor.'}</p>
      ${ready && !state.done.has('reconstructed') ? '<button class="btn-ghost" id="tx-recon">RECONSTRUCT FINAL TRANSMISSION</button>' : ''}`);
    station = 'transmitter';
    body.querySelector('#tx-recon')?.addEventListener('click', openReconstruction);
    return;
  }

  const body = modal('TRANSMITTER TX-2 · SEALED 1979', 'Frequency Tuning', `
    <div class="tx">
      <canvas id="tx-dial" width="300" height="300"></canvas>
      <div>
        <div class="tx-readout" id="tx-read">5.000 <small>MHz</small></div>
        <input type="range" id="tx-range" min="${FREQ_MIN}" max="${FREQ_MAX}" step="0.001" value="5" />
        <div class="fine-row">
          ${[-0.1, -0.01, -0.001, 0.001, 0.01, 0.1].map((d) => `<button class="btn-ghost amber" data-step="${d}">${d > 0 ? '+' : '−'}${Math.abs(d)}</button>`).join('')}
        </div>
        <div class="strength">CARRIER STRENGTH <span id="tx-state">SEARCHING</span><div class="meter"><i id="tx-meter"></i></div></div>
        <canvas class="tx-scope" id="tx-scope" width="480" height="70"></canvas>
        <p class="hint">Drag the slider, scroll over the dial, or use <kbd>←</kbd> <kbd>→</kbd> (hold <kbd>Shift</kbd> for fine steps). Find the carrier the night operator logged and hold the needle on it.</p>
      </div>
    </div>`);
  station = 'transmitter';

  const dial = (body.querySelector('#tx-dial') as HTMLCanvasElement).getContext('2d')!;
  const scope = (body.querySelector('#tx-scope') as HTMLCanvasElement).getContext('2d')!;
  const range = body.querySelector('#tx-range') as HTMLInputElement;
  let f = 5.0;
  let hold = 0;
  let raf = 0;
  let last = performance.now();
  let finished = false;

  const set = (v: number) => {
    f = Math.min(FREQ_MAX, Math.max(FREQ_MIN, Math.round(v * 1000) / 1000));
    range.value = String(f);
  };
  range.addEventListener('input', () => set(Number(range.value)));
  body.querySelectorAll<HTMLButtonElement>('[data-step]').forEach((b) => b.addEventListener('click', () => set(f + Number(b.dataset.step))));
  dial.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    set(f + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.001 : 0.01));
  }, { passive: false });
  const onKey = (e: KeyboardEvent) => {
    if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
      e.preventDefault();
      set(f + (e.code === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 0.001 : 0.02));
    }
  };
  window.addEventListener('keydown', onKey);

  const loop = () => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    const d = f - TARGET_FREQUENCY;
    const prox = Math.exp(-Math.abs(d) / 0.35);
    const onTarget = Math.abs(d) <= FREQ_TOLERANCE + 1e-9;
    hold = onTarget ? hold + dt : 0;

    $('#tx-read').innerHTML = `${f.toFixed(3)} <small>MHz</small>`;
    $('#tx-read').classList.toggle('locked', onTarget);
    $('#tx-meter').style.width = `${prox * 100}%`;
    $('#tx-state').textContent = onTarget ? `HOLDING ${Math.min(100, Math.round((hold / 1.5) * 100))}%` : prox > 0.8 ? 'VOICE BLEEDING THROUGH' : prox > 0.4 ? 'FAINT CARRIER' : 'SEARCHING';
    drawTxDial(dial, f, onTarget);

    const W = scope.canvas.width, H = scope.canvas.height;
    scope.fillStyle = '#031208';
    scope.fillRect(0, 0, W, H);
    scope.strokeStyle = '#7dffb4';
    scope.lineWidth = 1.5;
    scope.beginPath();
    for (let x = 0; x < W; x += 2) {
      const y = H / 2 + Math.sin(x * 0.08 + now * 0.008) * 22 * prox + (Math.random() - 0.5) * 50 * (1 - prox);
      if (x === 0) scope.moveTo(x, y); else scope.lineTo(x, y);
    }
    scope.stroke();

    setTuning(true, prox, Math.max(-1, Math.min(1, d / 2)));
    world.setFrequency(f, onTarget ? 1 : prox * 0.9);

    if (hold >= 1.5 && !finished) {
      finished = true;
      blip(990, 0.3);
      discover('E5');
      state.complete('tuned');
      setTimeout(() => station === 'transmitter' && renderTransmitter(), 600);
      return;
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  modalCleanup = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey);
    setTuning(false);
    if (!state.done.has('tuned')) world.setFrequency(f, 0);
  };
}

// ------------------------------------------------------------------ reconstruction (deterministic)

function openReconstruction() {
  const pool = ['F2', 'F3', 'F1']; // fixed scrambled presentation
  const order: string[] = [];
  const body = modal('TX-2 · LOOP CLOSURE', 'Reconstruct the Final Transmission', `
    <p class="hint" style="margin-top:0">Place the three fragments in the order they were transmitted, then key TX-2. The evidence file (timecodes) tells you how. THE SIGNAL may advise, but the transmitter decides.</p>
    <div class="recon-slots" id="slots"></div>
    <div class="recon-pool" id="pool"></div>
    <div class="recon-actions" style="margin-top:14px">
      <button class="btn-ghost amber" id="r-clear">CLEAR</button>
      <button class="btn-ghost" id="r-send" disabled>KEY TRANSMITTER</button>
    </div>
    <div class="msg" id="r-msg"></div>`);
  station = 'recon';

  const draw = () => {
    $('#slots').innerHTML = [0, 1, 2]
      .map((i) => (order[i]
        ? `<div class="slot filled"><b>${i + 1}</b>${esc(FRAGMENTS[order[i]].text)}</div>`
        : `<div class="slot"><b>${i + 1}</b>empty</div>`))
      .join('');
    $('#pool').innerHTML = pool
      .map((id) => `<button class="frag-card" data-frag="${id}" ${order.includes(id) ? 'disabled' : ''}>“${esc(FRAGMENTS[id].text)}”</button>`)
      .join('');
    body.querySelectorAll<HTMLButtonElement>('[data-frag]').forEach((b) =>
      b.addEventListener('click', () => {
        order.push(b.dataset.frag!);
        blip(520 + order.length * 120, 0.06);
        draw();
      }),
    );
    ($('#r-send') as HTMLButtonElement).disabled = order.length !== 3;
  };
  draw();
  $('#r-clear').addEventListener('click', () => {
    order.length = 0;
    $('#r-msg').textContent = '';
    draw();
  });
  $('#r-send').addEventListener('click', () => {
    if (isCorrectOrder(order)) {
      $('#r-msg').className = 'msg good';
      $('#r-msg').textContent = 'Sequence accepted. The loop is closing…';
      state.complete('reconstructed');
      setTimeout(runEnding, 1200);
    } else {
      blip(140, 0.5);
      $('#r-msg').className = 'msg bad';
      $('#r-msg').textContent = 'TX-2 rejects the sequence. Static floods the band. Check the fragment timecodes.';
      order.length = 0;
      draw();
    }
  });
}

function runEnding() {
  ended = true;
  closeOverlay(false);
  if (document.pointerLockElement) document.exitPointerLock();
  $('#hud').classList.add('hidden');
  world.movementEnabled = false;
  world.startFinale();
  silence();
  setTimeout(() => {
    $('#ending').classList.remove('hidden');
    const out = $('#final-text');
    let i = 0;
    const iv = setInterval(() => {
      out.textContent = FINAL_TRANSMISSION.slice(0, ++i);
      if (i >= FINAL_TRANSMISSION.length) {
        clearInterval(iv);
        $('#epilogue').textContent = EPILOGUE;
        setTimeout(() => $('#epilogue').classList.add('show'), 400);
      }
    }, 28);
    $('#ending-stats').textContent = `Evidence recovered ${state.discovered.length}/${state.totalItems()} · THE SIGNAL: ${signal.summary()}`;
  }, 3500);
}

// ------------------------------------------------------------------ input & boot

window.addEventListener('keydown', (e) => {
  if (!started || ended) return;
  const typing = (e.target as HTMLElement)?.tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'text';
  if (e.code === 'Escape') {
    if (overlay) closeOverlay();
    return;
  }
  if (typing) return;
  if (e.code === 'KeyE' && !overlay && target) openStation(target);
  else if (e.code === 'KeyJ') toggle('evidence');
  else if (e.code === 'KeyT') toggle('signal');
});

$('#start').addEventListener('click', () => {
  started = true;
  clockStart = performance.now();
  $('#title').classList.add('hidden');
  $('#hud').classList.remove('hidden');
  startAudio();
  world.movementEnabled = true;
  capture();
});
$('#resume').addEventListener('click', () => {
  $('#pause').classList.add('hidden');
  capture();
});
world.renderer.domElement.addEventListener('click', () => {
  if (started && !ended && !overlay && !document.pointerLockElement) capture();
});

// debug hook for automated screenshots / testing
(window as any).__deadair = { state, world, openStation, openReconstruction, toggle };
