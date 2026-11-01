// Procedural ambience: room hum, radio static and a carrier tone. No audio assets.

let ctx: AudioContext | null = null;
let staticGain: GainNode;
let carrierGain: GainNode;
let carrierOsc: OscillatorNode;
let staticFilter: BiquadFilterNode;
let master: GainNode;

function noiseBuffer(ac: AudioContext) {
  const len = ac.sampleRate * 2;
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.04 * white) / 1.04;
    data[i] = last * 3 + white * 0.25;
  }
  return buf;
}

export function startAudio() {
  if (ctx) return;
  try {
    ctx = new AudioContext();
  } catch {
    return;
  }
  master = ctx.createGain();
  master.gain.value = 0.55;
  master.connect(ctx.destination);

  // mains hum
  const hum = ctx.createOscillator();
  hum.frequency.value = 50;
  const humGain = ctx.createGain();
  humGain.gain.value = 0.035;
  hum.connect(humGain).connect(master);
  hum.start();

  // static bed
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;
  staticFilter = ctx.createBiquadFilter();
  staticFilter.type = 'bandpass';
  staticFilter.frequency.value = 1800;
  staticFilter.Q.value = 0.6;
  staticGain = ctx.createGain();
  staticGain.gain.value = 0.05;
  src.connect(staticFilter).connect(staticGain).connect(master);
  src.start();

  // carrier tone (audible when tuning nears the target)
  carrierOsc = ctx.createOscillator();
  carrierOsc.type = 'sine';
  carrierOsc.frequency.value = 731.7;
  carrierGain = ctx.createGain();
  carrierGain.gain.value = 0;
  carrierOsc.connect(carrierGain).connect(master);
  carrierOsc.start();
}

/** lock: 0 = pure static, 1 = locked onto carrier */
export function setTuning(active: boolean, lock = 0, detune = 0) {
  if (!ctx) return;
  const t = ctx.currentTime;
  if (!active) {
    staticGain.gain.setTargetAtTime(0.05, t, 0.2);
    carrierGain.gain.setTargetAtTime(0, t, 0.2);
    return;
  }
  staticGain.gain.setTargetAtTime(0.22 * (1 - lock) + 0.02, t, 0.05);
  staticFilter.frequency.setTargetAtTime(900 + detune * 2400, t, 0.05);
  carrierGain.gain.setTargetAtTime(0.12 * lock * lock, t, 0.05);
  carrierOsc.frequency.setTargetAtTime(731.7 + detune * 900, t, 0.05);
}

export function blip(freq = 880, dur = 0.08) {
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'square';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.05, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
  o.connect(g).connect(master);
  o.start();
  o.stop(ctx.currentTime + dur);
}

export function silence() {
  if (!ctx) return;
  master.gain.setTargetAtTime(0.0, ctx.currentTime, 1.5);
}
