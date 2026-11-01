/// <reference lib="webworker" />
// Runs Gemma 4 E2B locally via Transformers.js on WebGPU. Nothing leaves the browser
// except the one-time model download from the Hugging Face Hub.
import {
  AutoTokenizer,
  Gemma4ForCausalLM,
  InterruptableStoppingCriteria,
  TextStreamer,
} from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX';

type InMsg =
  | { type: 'load' }
  | { type: 'generate'; id: number; messages: { role: string; content: string }[]; maxTokens: number }
  | { type: 'stop' };

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

let tokenizer: any = null;
let model: any = null;
const stopper = new InterruptableStoppingCriteria();

async function load() {
  const gpu = (navigator as any).gpu;
  if (!gpu) throw new Error('WebGPU is not available in this browser/worker.');
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter found (GPU blocklisted or disabled).');
  const fp16 = adapter.features.has('shader-f16');
  const dtype = fp16 ? 'q4f16' : 'q4';
  post({ type: 'status', text: `WebGPU adapter ready · shader-f16 ${fp16 ? 'yes' : 'no'} · dtype ${dtype}` });

  tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
  // Gemma4ForCausalLM loads the text-only path (embed_tokens + decoder) and skips
  // the vision and audio encoders, which roughly halves the download.
  model = await Gemma4ForCausalLM.from_pretrained(MODEL_ID, {
    dtype,
    device: 'webgpu',
    progress_callback: (info: any) => {
      if (info.status === 'progress_total') {
        const active = Object.entries(info.files ?? {})
          .filter(([, f]: [string, any]) => f.total && f.loaded < f.total)
          .map(([name]) => name.split('/').pop());
        post({ type: 'progress', progress: info.progress, loaded: info.loaded, total: info.total });
        if (active.length) post({ type: 'status', text: `Downloading ${active.join(', ')}` });
      } else if (info.status === 'initiate' && info.file) {
        post({ type: 'status', text: `Fetching ${info.file}` });
      }
    },
  });

  post({ type: 'status', text: 'Compiling WebGPU shaders (warm-up)…' });
  const warm = tokenizer('a', { return_tensor: true });
  await model.generate({ ...warm, max_new_tokens: 1 });
  post({ type: 'ready', dtype });
}

async function generate(id: number, messages: { role: string; content: string }[], maxTokens: number) {
  const inputs = tokenizer.apply_chat_template(messages, {
    add_generation_prompt: true,
    return_dict: true,
    enable_thinking: false,
  });
  let tokens = 0;
  let started = 0;
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text: string) => {
      post({ type: 'token', id, text });
    },
    token_callback_function: () => {
      if (!started) started = performance.now();
      tokens++;
    },
  });
  stopper.reset();
  await model.generate({
    ...inputs,
    max_new_tokens: maxTokens,
    do_sample: false,
    repetition_penalty: 1.05,
    streamer,
    stopping_criteria: stopper,
  });
  const secs = started ? (performance.now() - started) / 1000 : 0;
  post({ type: 'done', id, tokens, tps: secs > 0 ? tokens / secs : 0 });
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') await load();
    else if (msg.type === 'generate') await generate(msg.id, msg.messages, msg.maxTokens);
    else if (msg.type === 'stop') stopper.interrupt();
  } catch (err) {
    post({ type: 'error', id: 'id' in msg ? msg.id : undefined, text: err instanceof Error ? err.message : String(err) });
  }
};
