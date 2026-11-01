import { EVIDENCE, FRAGMENTS, getItem, type Evidence } from './story';

export type Step = 'log' | 'ch1' | 'ch2' | 'tuned' | 'ch3' | 'reconstructed';

export const STEPS: { id: Step; label: string }[] = [
  { id: 'log', label: 'Read the incident log' },
  { id: 'ch1', label: 'Decode monitor channel 1' },
  { id: 'ch2', label: 'Apply filter band 2 on the monitor' },
  { id: 'tuned', label: 'Tune TX-2 to the logged carrier' },
  { id: 'ch3', label: 'Capture the TX-2 fragment' },
  { id: 'reconstructed', label: 'Reconstruct the final transmission' },
];

type Listener = () => void;

class GameState {
  readonly discovered: string[] = [];
  readonly done = new Set<Step>();
  private listeners: Listener[] = [];

  onChange(fn: Listener) {
    this.listeners.push(fn);
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  discover(...ids: string[]): string[] {
    const fresh = ids.filter((id) => getItem(id) && !this.discovered.includes(id));
    if (fresh.length) {
      this.discovered.push(...fresh);
      this.emit();
    }
    return fresh;
  }

  complete(step: Step) {
    if (this.done.has(step)) return;
    this.done.add(step);
    this.emit();
  }

  has(id: string) {
    return this.discovered.includes(id);
  }

  evidence(): Evidence[] {
    return this.discovered.map((id) => getItem(id)!);
  }

  fragments() {
    return this.discovered.filter((id) => id in FRAGMENTS).map((id) => FRAGMENTS[id]);
  }

  allFragments() {
    return Object.keys(FRAGMENTS).every((id) => this.has(id));
  }

  progress() {
    return this.done.size / STEPS.length;
  }

  nextObjective(): string {
    const next = STEPS.find((s) => !this.done.has(s.id));
    return next ? next.label : 'Transmission closed';
  }

  totalItems() {
    return Object.keys(EVIDENCE).length + Object.keys(FRAGMENTS).length;
  }
}

export const state = new GameState();
