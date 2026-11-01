import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, NO_SIGNAL } from '../src/signal/signal.ts';
import { EVIDENCE } from '../src/story.ts';

const LOG = ['E1', 'E2', 'E3'].map((id) => EVIDENCE[id]);

test('a fully cited answer is VERIFIED', () => {
  // Gemma's live answer on GitHub Pages, 2026-11-01.
  const v = validate(
    'The direction finder indicated a bearing from inside the facility [E1]. The signal was detected on 7.317 MHz [E1]. Monitoring of that frequency is now prohibited [E3].',
    LOG,
  );
  assert.equal(v.status, 'verified');
  assert.equal(v.sentences.length, 3);
  assert.deepEqual(v.sentences.map((s) => s.cites), [['E1'], ['E1'], ['E3']]);
});

test('citations after the full stop and multi-ID citations are understood', () => {
  const v = validate('The night operator was M. Okafor. [E1, E3]', LOG);
  assert.equal(v.status, 'verified');
  assert.deepEqual(v.sentences[0].cites, ['E1', 'E3']);
});

test('"NO SIGNAL ON THAT BAND." is passed through as no-signal', () => {
  const v = validate(NO_SIGNAL, LOG);
  assert.equal(v.status, 'no-signal');
});

// ---------------------------------------------------------------- sentence splitting

test('a title like "Dr." does not end the sentence', () => {
  const v = validate('The night operator was Dr. Harold Vance [E1].', LOG);
  assert.equal(v.sentences.length, 1);
  assert.equal(v.sentences[0].text, 'The night operator was Dr. Harold Vance.');
});

test('initials like "M. Okafor" do not end the sentence', () => {
  const v = validate('The operator on duty was M. Okafor [E1].', LOG);
  assert.equal(v.sentences.length, 1);
  assert.equal(v.status, 'verified');
});

test('"e.g." followed by lowercase does not split, "a.m." followed by a capital does', () => {
  const v = validate('Routing went to band 2, e.g. the filter [E2]. It came at 3 a.m. The log says so [E1].', LOG);
  assert.deepEqual(
    v.sentences.map((s) => s.text),
    ['Routing went to band 2, e.g. the filter.', 'It came at 3 a.m.', 'The log says so.'],
  );
});

test('decimal frequencies and times are not sentence boundaries', () => {
  const v = validate('Carrier on 7.317 MHz at 03:09 [E1].', LOG);
  assert.equal(v.sentences.length, 1);
  assert.equal(v.status, 'verified');
});

// ---------------------------------------------------------------- rejections

test('a sentence without a citation is struck out', () => {
  const v = validate('The carrier comes from Mars.', LOG);
  assert.equal(v.status, 'rejected');
  assert.equal(v.sentences[0].reason, 'no evidence reference');
});

test('citing undiscovered evidence is rejected', () => {
  const v = validate('The fragment proves it [F3].', LOG);
  assert.equal(v.status, 'rejected');
  assert.match(v.sentences[0].reason!, /undiscovered evidence F3/);
});

test('citing a nonexistent ID is rejected', () => {
  assert.equal(validate('It is confirmed [E9].', LOG).status, 'rejected');
});

test('a number missing from the cited evidence is rejected', () => {
  const v = validate('The aliens landed in 1985 [E2].', LOG);
  assert.equal(v.status, 'rejected');
  assert.match(v.sentences[0].reason!, /"1985" is not in the cited evidence/);
});

test('a number from a different evidence item than the one cited is rejected', () => {
  // 7.317 is in E1 and E3, not in E2.
  assert.equal(validate('The operator tuned to 7.317 MHz [E2].', LOG).status, 'rejected');
});

test('an invented proper noun after a title is rejected', () => {
  const v = validate('The night operator was Dr. Harold Vance [E1].', LOG);
  assert.equal(v.status, 'rejected');
  assert.match(v.sentences[0].reason!, /"Harold" does not appear in any evidence/);
});

test('mixing a supported and an unsupported sentence gives PARTIAL', () => {
  const v = validate(
    'The signal was detected on 7.317 MHz [E1]. It was sent by Dr. Harold Vance from Mars in 1985 [E1].',
    LOG,
  );
  assert.equal(v.status, 'partial');
  assert.equal(v.sentences.length, 2);
  assert.equal(v.sentences[0].ok, true);
  assert.equal(v.sentences[1].ok, false);
  assert.equal(v.sentences[1].text, 'It was sent by Dr. Harold Vance from Mars in 1985.');
});
