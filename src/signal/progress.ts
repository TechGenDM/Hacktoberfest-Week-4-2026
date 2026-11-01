// Turns Transformers.js progress_callback events into one honest loading figure.
//
// The library's own `progress_total` event sums every file the model *could* need, including the
// vision and audio encoders that Gemma4ForCausalLM never fetches, so it stalls around 92%. Here a
// file only counts once it has actually been requested (an `initiate` or `progress` event for it).

export type LoadPhase = 'resolving' | 'download' | 'init' | 'warmup' | 'ready';

export interface LoadSnapshot {
  phase: LoadPhase;
  /** 0–100. Only reaches 100 once warm-up has finished. */
  percent: number;
  /** Bytes of requested files received so far (from the network or the browser cache). */
  loaded: number;
  /** Total bytes of requested files. */
  total: number;
  /** Files still transferring. */
  active: string[];
}

export interface ProgressEvent {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
  files?: Record<string, { loaded: number; total: number }>;
}

// Share of the bar for each stage. Downloading is by far the longest, so it gets most of it.
const DOWNLOAD_CEIL = 95;
const INIT_AT = 96;
const WARMUP_AT = 98;

export class LoadProgress {
  private files = new Map<string, { loaded: number; total: number }>();
  /** True once the model's file list is known, i.e. every weight file has been requested. */
  private resolved = false;
  private stage: 'files' | 'warmup' | 'ready' = 'files';
  private shown = 0;

  update(info: ProgressEvent) {
    const file = info.file;
    switch (info.status) {
      case 'initiate':
        if (file && !this.files.has(file)) this.files.set(file, { loaded: 0, total: 0 });
        break;
      case 'progress': {
        if (!file) break;
        const f = this.files.get(file) ?? { loaded: 0, total: 0 };
        f.loaded = info.loaded ?? f.loaded;
        f.total = info.total || f.total;
        this.files.set(file, f);
        // Fallback if `progress_total` never arrives: weights are only requested after the file list is known.
        if (/\.onnx(_data)?$/.test(file)) this.resolved = true;
        break;
      }
      case 'done': {
        const f = file ? this.files.get(file) : undefined;
        if (f?.total) f.loaded = f.total;
        break;
      }
      case 'progress_total':
        // Emitted only after Transformers.js has resolved the model's files and requested them, so
        // this is the first moment the total is meaningful. Borrow sizes for requested files only.
        this.resolved = true;
        for (const [name, meta] of Object.entries(info.files ?? {})) {
          const f = this.files.get(name);
          if (f && !f.total) f.total = meta.total;
        }
        break;
    }
  }

  warmup() {
    this.stage = 'warmup';
  }

  ready() {
    this.stage = 'ready';
  }

  snapshot(): LoadSnapshot {
    let loaded = 0;
    let total = 0;
    const active: string[] = [];
    for (const [name, f] of this.files) {
      loaded += Math.min(f.loaded, f.total || f.loaded);
      total += f.total;
      if (f.total && f.loaded < f.total) active.push(name);
    }

    let phase: LoadPhase;
    let pct: number;
    if (this.stage === 'ready') [phase, pct] = ['ready', 100];
    else if (this.stage === 'warmup') [phase, pct] = ['warmup', WARMUP_AT];
    else if (!this.resolved) [phase, pct] = ['resolving', 0];
    else if (total > 0 && loaded >= total) [phase, pct] = ['init', INIT_AT];
    else [phase, pct] = ['download', total > 0 ? (loaded / total) * DOWNLOAD_CEIL : 0];

    // Totals can grow as late files are requested; never let the bar move backwards.
    this.shown = Math.max(this.shown, pct);
    return { phase, percent: this.shown, loaded, total, active };
  }
}

export function describePhase(s: LoadSnapshot): string {
  switch (s.phase) {
    case 'resolving':
      return 'Resolving model files…';
    case 'download':
      // Files come from the network on first run and from the browser cache afterwards.
      return s.active.length ? `Fetching ${s.active.map((f) => f.split('/').pop()).join(', ')}` : 'Fetching model files…';
    case 'init':
      return 'All files received. Creating WebGPU sessions…';
    case 'warmup':
      return 'Compiling WebGPU shaders (warm-up)…';
    case 'ready':
      return 'READY · Gemma 4 E2B is loaded and warmed up.';
  }
}
