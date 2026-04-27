import test from "node:test";
import assert from "node:assert/strict";
import { OrderedSegmentQueue } from "../src/application/OrderedSegmentQueue";

test("OrderedSegmentQueue commits strictly in segment order", async () => {
  const committed: number[] = [];
  const queue = new OrderedSegmentQueue(async (segment) => {
    committed.push(segment.index);
  });

  queue.enqueue([
    { index: 2, path: "segment-0002.mp3" },
    { index: 0, path: "segment-0000.mp3" },
    { index: 1, path: "segment-0001.mp3" },
  ]);

  await queue.whenIdle();
  assert.deepEqual(committed, [0, 1, 2]);
});

test("OrderedSegmentQueue ignores already committed segments", async () => {
  const committed: number[] = [];
  const queue = new OrderedSegmentQueue(async (segment) => {
    committed.push(segment.index);
  }, 1);

  queue.enqueue([
    { index: 0, path: "segment-0000.mp3" },
    { index: 1, path: "segment-0001.mp3" },
  ]);

  await queue.whenIdle();
  assert.deepEqual(committed, [1]);
});

test("OrderedSegmentQueue resumes from the next expected segment index", async () => {
  const committed: number[] = [];
  const queue = new OrderedSegmentQueue(async (segment) => {
    committed.push(segment.index);
  }, 1);

  queue.enqueue([
    { index: 1, path: "segment-0001.mp3" },
    { index: 2, path: "segment-0002.mp3" },
  ]);

  await queue.whenIdle();
  assert.deepEqual(committed, [1, 2]);
});
