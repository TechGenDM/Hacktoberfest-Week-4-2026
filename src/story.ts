// Canonical story data. Everything the player (and THE SIGNAL) can know lives here.
// The model is never given anything that is not in DISCOVERED evidence.

export type EvidenceKind = 'log' | 'fragment' | 'instrument';

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  title: string;
  source: string;
  text: string;
}

export interface Fragment extends Evidence {
  kind: 'fragment';
  /** Offset inside the transmission, in seconds. Drives the deterministic reconstruction. */
  offset: number;
  timecode: string;
}

export const TARGET_FREQUENCY = 7.317; // MHz
export const FREQ_MIN = 3.0;
export const FREQ_MAX = 9.999;
export const FREQ_TOLERANCE = 0.004;

export const EVIDENCE: Record<string, Evidence> = {
  E1: {
    id: 'E1',
    kind: 'log',
    title: 'Log entry — 14 MAR 1979, 03:09',
    source: 'Incident log',
    text: 'Unidentified narrowband carrier on 7.317 MHz. Direction finder gives a bearing from inside the facility, not from the dish. Operator: M. Okafor.',
  },
  E2: {
    id: 'E2',
    kind: 'log',
    title: 'Log entry — 14 MAR 1979, 03:17',
    source: 'Incident log',
    text: 'The carrier contains a voice. It is my voice. It is reading this entry aloud before I have finished writing it. Routing the signal monitor to filter band 2. — M. Okafor',
  },
  E3: {
    id: 'E3',
    kind: 'log',
    title: 'Decommission notice — 02 APR 1979',
    source: 'Incident log',
    text: 'Night operator M. Okafor reported missing after the 14 March shift. Transmitter TX-2 sealed. Monitoring of 7.317 MHz is prohibited. Kestrel Ridge Observatory closed.',
  },
  E4: {
    id: 'E4',
    kind: 'instrument',
    title: 'Monitor analysis — origin trace',
    source: 'Signal monitor',
    text: 'Transmission origin resolves to local transmitter TX-2. Timestamp offset: the signal is received 17 minutes before it is transmitted.',
  },
  E5: {
    id: 'E5',
    kind: 'instrument',
    title: 'TX-2 service plate',
    source: 'Radio transmitter',
    text: 'TX-2 last keyed 14 MAR 1979 at 03:34. Seal broken. Dial left at 7.317 MHz.',
  },
};

export const FRAGMENTS: Record<string, Fragment> = {
  F1: {
    id: 'F1',
    kind: 'fragment',
    title: 'Fragment I — channel 1',
    source: 'Signal monitor',
    offset: 0,
    timecode: 'T+00:00',
    text: 'This is Kestrel Ridge Observatory, night operator Okafor. If you can hear this, it is 03:17 again.',
  },
  F2: {
    id: 'F2',
    kind: 'fragment',
    title: 'Fragment II — channel 2 (filter band 2)',
    source: 'Signal monitor',
    offset: 41,
    timecode: 'T+00:41',
    text: 'The carrier is not coming from the sky. It comes from the transmitter in this room, seventeen minutes before anyone keys it.',
  },
  F3: {
    id: 'F3',
    kind: 'fragment',
    title: 'Fragment III — channel 3 (TX-2 feed)',
    source: 'Signal monitor',
    offset: 77,
    timecode: 'T+01:17',
    text: 'Do not answer me. Return the dial to zero and let the dead air close the loop.',
  },
};

/**
 * Exact facts THE SIGNAL answers by evidence lookup instead of generation. A question is routed
 * here only when it opens with `asks`, mentions `about` and matches no other fact. The answer is
 * the statement of the first discovered evidence item in `statements`, cited with that item's ID.
 * Each statement must hold up under the validator against its own evidence (see test/facts.test.ts).
 */
export interface Fact {
  id: string;
  asks: RegExp;
  about: RegExp;
  statements: [evidenceId: string, statement: string][];
}

export const FACTS: Fact[] = [
  {
    id: 'carrier-frequency',
    asks: /^(what|which)\b/,
    about: /\b(frequenc\w*|mhz|tune|tuning|dial)\b/,
    statements: [
      ['E1', `The carrier was logged on ${TARGET_FREQUENCY} MHz.`],
      ['E5', `TX-2's dial was left at ${TARGET_FREQUENCY} MHz.`],
    ],
  },
  {
    id: 'filter-band',
    asks: /^(what|which)\b/,
    about: /\b(filter|band)\b/,
    statements: [['E2', 'The operator routed the signal monitor to filter band 2.']],
  },
  {
    id: 'night-operator',
    asks: /^who\b/,
    about: /\boperator\b/,
    statements: [
      ['E1', 'The operator on duty was M. Okafor.'],
      ['E3', 'The night operator was M. Okafor.'],
    ],
  },
  {
    id: 'tx2-last-keyed',
    asks: /^(when|what time|at what time)\b/,
    about: /\bkeyed\b/,
    statements: [['E5', 'TX-2 was last keyed on 14 MAR 1979 at 03:34.']],
  },
  {
    id: 'signal-offset',
    asks: /^(how|when)\b/,
    about: /\b(early|earlier|before it is transmitted|offset|minutes)\b/,
    statements: [['E4', 'The signal is received 17 minutes before it is transmitted.']],
  },
];

export function getItem(id: string): Evidence | undefined {
  return EVIDENCE[id] ?? FRAGMENTS[id];
}

/** Deterministic reconstruction: the only correct order is ascending transmission offset. */
export function correctOrder(): string[] {
  return Object.values(FRAGMENTS)
    .sort((a, b) => a.offset - b.offset)
    .map((f) => f.id);
}

export function isCorrectOrder(order: string[]): boolean {
  const c = correctOrder();
  return order.length === c.length && order.every((id, i) => id === c[i]);
}

export const FINAL_TRANSMISSION = correctOrder()
  .map((id) => FRAGMENTS[id].text)
  .join(' ');

export const EPILOGUE =
  'You return the TX-2 dial to zero. The carrier collapses into hiss, then into nothing. At 03:18 Kestrel Ridge is silent for the first time in forty-seven years. Somewhere in the static, a log entry finishes writing itself.';
