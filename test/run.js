import assert from 'node:assert/strict';
import {
  MAX_UIDS_PER_REQUEST,
  chunk,
  formatTransitionMessage,
  normalizeMonitorInput,
  normalizeTargetInput,
  parseLiveStatus,
  retryDelaySeconds,
} from '../src/core.js';

const tests = [
  ['normalizes room and UID monitor inputs', () => {
    assert.deepEqual(normalizeMonitorInput({ type: 'room', id: '21686237', label: '央视' }), {
      type: 'room', sourceId: '21686237', label: '央视',
    });
    assert.throws(() => normalizeMonitorInput({ type: 'room', id: 'abc' }), /数字/);
  }],
  ['normalizes private and group targets', () => {
    assert.deepEqual(normalizeTargetInput({ type: 'private', id: 'openid-1' }), {
      type: 'private', targetId: 'openid-1', label: '',
    });
    assert.throws(() => normalizeTargetInput({ type: 'channel', id: 'x' }), /private 或 group/);
  }],
  ['chunks values without exceeding the Bilibili batch size', () => {
    const values = Array.from({ length: 101 }, (_, index) => index);
    assert.deepEqual(chunk(values, MAX_UIDS_PER_REQUEST).map(part => part.length), [50, 50, 1]);
  }],
  ['only live statuses 0 and 1 are transition candidates', () => {
    assert.equal(parseLiveStatus(0), 0);
    assert.equal(parseLiveStatus(1), 1);
    assert.equal(parseLiveStatus(2), null);
    assert.equal(parseLiveStatus('unknown'), null);
  }],
  ['formats text and markdown start/end notifications', () => {
    const text = formatTransitionMessage({ status: 1, uname: '主播', title: '今晚直播', roomId: '123', format: 'text' });
    assert.match(text, /【B站开播】/);
    assert.match(text, /https:\/\/live\.bilibili\.com\/123/);
    const markdown = formatTransitionMessage({ status: 0, uname: '主播', title: '今晚直播', roomId: '123', format: 'markdown' });
    assert.match(markdown, /\*\*B站下播\*\*/);
  }],
  ['retry delay grows and is capped', () => {
    assert.equal(retryDelaySeconds(1), 30);
    assert.equal(retryDelaySeconds(3), 120);
    assert.equal(retryDelaySeconds(20), 3600);
  }],
];

for (const [name, run] of tests) {
  run();
  console.log(`ok - ${name}`);
}
console.log(`\n${tests.length} tests passed`);
