import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoadProgress, describePhase, type LoadSnapshot, type ProgressEvent } from '../src/signal/progress.ts';

// File sizes measured on the live site, 2026-11-01 (bytes, approximate for the small files).
const SIZES: Record<string, number> = {
  'tokenizer.json': 19_500_000,
  'tokenizer_config.json': 1_200,
  'config.json': 4_800,
  'generation_config.json': 200,
  'onnx/embed_tokens_q4f16.onnx': 1_000,
  'onnx/embed_tokens_q4f16.onnx_data': 1_520_600_000,
  'onnx/decoder_model_merged_q4f16.onnx': 700_000,
  'onnx/decoder_model_merged_q4f16.onnx_data': 1_591_600_000,
};
// Listed by Transformers.js up front but never fetched by Gemma4ForCausalLM.
const UNFETCHED: Record<string, number> = {
  'onnx/audio_encoder_q4f16.onnx': 600_000,
  'onnx/audio_encoder_q4f16.onnx_data': 150_000_000,
  'onnx/vision_encoder_q4f16.onnx': 500_000,
  'onnx/vision_encoder_q4f16.onnx_data': 100_000_000,
};
const MODEL_FILES = Object.keys(SIZES).filter((f) => f.startsWith('onnx/') || f === 'generation_config.json');
const REQUESTED_TOTAL = Object.values(SIZES).reduce((a, b) => a + b, 0);

const initiate = (file: string): ProgressEvent => ({ status: 'initiate', file });
const progress = (file: string, loaded: number): ProgressEvent => ({ status: 'progress', file, loaded, total: SIZES[file] });
const done = (file: string): ProgressEvent => ({ status: 'done', file });

/** The order Transformers.js 4.3 emits events in when the tokenizer and model load in parallel. */
function* coldLoadTrace(): Generator<ProgressEvent> {
  // Tokenizer and config resolve first; the model's file list is not known yet.
  for (const f of ['tokenizer.json', 'tokenizer_config.json', 'config.json']) {
    yield initiate(f);
    yield progress(f, SIZES[f]);
    yield done(f);
  }
  // Weights for both sessions are requested together after the metadata pass.
  for (const f of MODEL_FILES) yield initiate(f);
  const files = Object.fromEntries(
    [...Object.entries(SIZES), ...Object.entries(UNFETCHED)].map(([f, total]) => [f, { loaded: 0, total }]),
  );
  for (let step = 1; step <= 20; step++) {
    for (const f of MODEL_FILES) {
      const loaded = Math.round((SIZES[f] * step) / 20);
      files[f] = { loaded, total: SIZES[f] };
      yield progress(f, loaded);
      yield { status: 'progress_total', files: structuredClone(files) };
    }
  }
  for (const f of MODEL_FILES) yield done(f);
}

function run(events: Iterable<ProgressEvent>) {
  const p = new LoadProgress();
  const snaps: LoadSnapshot[] = [];
  for (const e of events) {
    p.update(e);
    snaps.push(p.snapshot());
  }
  return { p, snaps };
}

test('the total counts only requested files, not the unfetched encoders', () => {
  const { snaps } = run(coldLoadTrace());
  const last = snaps.at(-1)!;
  assert.equal(last.total, REQUESTED_TOTAL);
  assert.equal(last.loaded, REQUESTED_TOTAL);
  assert.ok(Math.abs(last.total / 1e9 - 3.13) < 0.01, `total ${last.total / 1e9} GB`);
});

test('full lifecycle: resolving → download → init → warmup → ready', () => {
  const { p, snaps } = run(coldLoadTrace());
  const phases = [...new Set(snaps.map((s) => s.phase))];
  assert.deepEqual(phases, ['resolving', 'download', 'init']);
  assert.equal(snaps.at(-1)!.percent, 96);

  p.warmup();
  assert.equal(p.snapshot().phase, 'warmup');
  assert.equal(p.snapshot().percent, 98);
  p.ready();
  assert.equal(p.snapshot().phase, 'ready');
  assert.equal(p.snapshot().percent, 100);
  assert.match(describePhase(p.snapshot()), /^READY/);
});

test('the bar stays at 0% until the model file list is known', () => {
  const { snaps } = run(coldLoadTrace());
  const resolving = snaps.filter((s) => s.phase === 'resolving');
  assert.ok(resolving.length > 0);
  assert.ok(resolving.every((s) => s.percent === 0), 'tokenizer finishing first must not fill the bar');
});

test('progress never goes backwards and never reaches 100% before ready', () => {
  const { snaps } = run(coldLoadTrace());
  for (let i = 1; i < snaps.length; i++) assert.ok(snaps[i].percent >= snaps[i - 1].percent);
  assert.ok(snaps.every((s) => s.percent < 100));
  assert.ok(snaps.filter((s) => s.phase === 'download').every((s) => s.percent <= 95));
});

test('a file requested late cannot pull the bar backwards', () => {
  const p = new LoadProgress();
  p.update(initiate('onnx/a.onnx_data'));
  p.update({ status: 'progress', file: 'onnx/a.onnx_data', loaded: 90, total: 100 });
  const before = p.snapshot().percent;
  p.update(initiate('onnx/b.onnx_data'));
  p.update({ status: 'progress', file: 'onnx/b.onnx_data', loaded: 0, total: 100 });
  assert.equal(p.snapshot().percent, before);
  assert.equal(p.snapshot().total, 200);
});

test('without progress_total, the first weight file resolves the list', () => {
  const p = new LoadProgress();
  p.update(initiate('config.json'));
  p.update({ status: 'progress', file: 'config.json', loaded: 10, total: 10 });
  assert.equal(p.snapshot().phase, 'resolving');
  p.update({ status: 'progress', file: 'onnx/decoder_model_merged_q4f16.onnx_data', loaded: 50, total: 100 });
  assert.equal(p.snapshot().phase, 'download');
});

test('a requested file that turns out not to exist does not block completion', () => {
  // Optional files that 404 emit `initiate` but never `progress` or `done`.
  const p = new LoadProgress();
  p.update(initiate('preprocessor_config.json'));
  p.update(initiate('onnx/a.onnx_data'));
  p.update({ status: 'progress', file: 'onnx/a.onnx_data', loaded: 100, total: 100 });
  p.update(done('onnx/a.onnx_data'));
  assert.equal(p.snapshot().phase, 'init');
});

test('the download phase names the files still transferring', () => {
  const p = new LoadProgress();
  p.update(initiate('onnx/decoder_model_merged_q4f16.onnx_data'));
  p.update({ status: 'progress', file: 'onnx/decoder_model_merged_q4f16.onnx_data', loaded: 1, total: 100 });
  assert.equal(describePhase(p.snapshot()), 'Fetching decoder_model_merged_q4f16.onnx_data');
});
