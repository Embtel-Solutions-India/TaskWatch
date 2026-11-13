// Pure tests for @mention matching (CMT-01, D-136 single names).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mentionedNames } from '@taskwatch/shared/notifications';

const NAMES = ['Raj', 'Rajesh Kumar', 'Ana', 'Ana Lee', 'J. (Jo) O\'Neil+'];
const m = (body: string) => [...mentionedNames(body, NAMES)].sort();

describe('mentionedNames', () => {
  it('a single name is mentioned on its own, at the end or before punctuation', () => {
    assert.deepEqual(m('@Raj'), ['Raj']);
    assert.deepEqual(m('thanks @Raj, please check'), ['Raj']);
  });
  it('a name is not mentioned inside a longer word or name', () => {
    assert.deepEqual(m('@Rajesh Kumar can you look'), ['Rajesh Kumar']);
    assert.deepEqual(m('@Rajesh'), []);
    assert.deepEqual(m('@Ana2'), []);
    assert.deepEqual(m('@Anaïs'), [], 'non-ASCII letters continue the word');
  });
  it('the longest name wins, and both can still be mentioned separately', () => {
    assert.deepEqual(m('@Ana Lee'), ['Ana Lee']);
    assert.deepEqual(m('@Ana Lee and @Ana'), ['Ana', 'Ana Lee']);
  });
  it('regex characters in a name are literal; no @ means no mention', () => {
    assert.deepEqual(m("cc @J. (Jo) O'Neil+"), ["J. (Jo) O'Neil+"]);
    assert.deepEqual(m('Raj and Ana'), []);
  });
});
