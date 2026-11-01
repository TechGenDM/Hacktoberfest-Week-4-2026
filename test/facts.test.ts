import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupFact, validate } from '../src/signal/signal.ts';
import { EVIDENCE, FACTS, FRAGMENTS, getItem } from '../src/story.ts';

const ev = (...ids: string[]) => ids.map((id) => getItem(id)!);
const ALL = ev(...Object.keys(EVIDENCE), ...Object.keys(FRAGMENTS));
const LOG = ev('E1', 'E2', 'E3');

test('every fact statement is VERIFIED against its own evidence item alone', () => {
  for (const fact of FACTS) {
    for (const [id, statement] of fact.statements) {
      const v = validate(`${statement} [${id}]`, ev(id));
      assert.equal(v.status, 'verified', `${fact.id} / ${id}: ${v.sentences[0]?.reason}`);
    }
  }
});

test('the TX-2 tuning question is answered from E1 with the logged frequency', () => {
  const hit = lookupFact('What frequency should I tune TX-2 to?', LOG, FACTS);
  assert.ok(hit);
  assert.equal(hit.fact, 'carrier-frequency');
  assert.equal(hit.source.id, 'E1');
  assert.equal(hit.verdict.status, 'verified');
  assert.deepEqual(hit.verdict.sentences.map((s) => s.cites), [['E1']]);
  assert.match(hit.raw, /7\.317 MHz/);
});

test('the first discovered source in the fact is used', () => {
  const hit = lookupFact('What frequency is TX-2 dialled to?', ev('E5'), FACTS);
  assert.equal(hit?.source.id, 'E5');
});

test('panel suggestion chips that ask for exact facts are looked up', () => {
  assert.equal(lookupFact('What frequency should TX-2 be on?', ALL, FACTS)?.fact, 'carrier-frequency');
  assert.equal(lookupFact('Which filter band did the operator use?', ALL, FACTS)?.fact, 'filter-band');
  assert.equal(lookupFact('Who was the night operator?', ALL, FACTS)?.fact, 'night-operator');
});

test('other exact facts are looked up', () => {
  assert.equal(lookupFact('When was TX-2 last keyed?', ALL, FACTS)?.fact, 'tx2-last-keyed');
  assert.equal(lookupFact('How early is the signal received?', ALL, FACTS)?.fact, 'signal-offset');
});

test('a fact whose evidence is undiscovered is not looked up', () => {
  assert.equal(lookupFact('Which filter band did the operator use?', ev('E1'), FACTS), null);
  assert.equal(lookupFact('When was TX-2 last keyed?', LOG, FACTS), null);
});

test('open-ended and interpretive questions go to the model', () => {
  for (const q of [
    'Where is the carrier coming from?',
    'How do the fragments fit together?',
    'What does the frequency mean?',
    'Why was monitoring of the frequency prohibited?',
    'What happened to the operator?',
  ]) {
    assert.equal(lookupFact(q, ALL, FACTS), null, q);
  }
});

test('questions with names or numbers outside the evidence go to the model', () => {
  assert.equal(lookupFact('Who sent the signal from Mars?', ALL, FACTS), null);
  assert.equal(lookupFact('Who was the operator before Dr. Vance?', ALL, FACTS), null);
  assert.equal(lookupFact('What frequency did the operator use in 1985?', ALL, FACTS), null);
});

test('a question matching more than one fact goes to the model', () => {
  assert.equal(lookupFact('What frequency and filter band did the operator use?', ALL, FACTS), null);
});
