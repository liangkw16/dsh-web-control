import { expect, test } from 'vitest';
import { BoundedQueue } from '../src/index.ts';
test('control can overtake bounded file data', () => {
  const queue = new BoundedQueue(1024, 256); queue.enqueue('data', new Uint8Array(768));
  expect(() => queue.enqueue('data', new Uint8Array(1))).toThrow('BACKPRESSURE');
  queue.enqueue('control', new Uint8Array([7])); expect(queue.take()).toEqual(new Uint8Array([7]));
});
test('total bound includes control, queued data and websocket buffered bytes', () => {
  const queue = new BoundedQueue(10, 2); queue.enqueue('data', new Uint8Array(8)); queue.enqueue('control', new Uint8Array(2));
  expect(queue.bytes).toBe(10); expect(() => queue.enqueue('control', new Uint8Array(1))).toThrow('BACKPRESSURE');
  queue.take(); expect(() => queue.enqueue('control', new Uint8Array(2), 1)).toThrow('BACKPRESSURE');
  queue.clear(); expect(queue.bytes).toBe(0); expect(queue.take()).toBeUndefined();
});
test('queue bounds survive invalid configuration, empty items and caller mutations', () => {
  for (const [limit, reserve] of [[NaN, 0], [Infinity, 0], [-1, 0], [1.2, 0], [1, 2], [1, -1]]) expect(() => new BoundedQueue(limit, reserve)).toThrow();
  const queue = new BoundedQueue(10, 2); expect(() => queue.enqueue('data', new Uint8Array())).toThrow();
  expect(() => queue.enqueue('unknown' as 'data', new Uint8Array([1]))).toThrow();
  expect(() => queue.enqueue('data', new Uint8Array([1]), NaN)).toThrow();
  const input = new Uint8Array([1]); queue.enqueue('data', input); input[0] = 7; expect(queue.take()).toEqual(new Uint8Array([1]));
  expect(() => new BoundedQueue(0, 0).enqueue('control', new Uint8Array([1]))).toThrow('BACKPRESSURE');
});
