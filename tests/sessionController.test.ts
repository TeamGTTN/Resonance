import test from "node:test";
import assert from "node:assert/strict";
import { collectSegmentDescriptors } from "../src/application/segmentFiles";

test("collectSegmentDescriptors skips the newest open segment during live polling", () => {
  const now = 10_000;
  const segments = collectSegmentDescriptors(
    [
      {
        name: "segment-0000.mp3",
        path: "/tmp/segment-0000.mp3",
        mtimeMs: now - 5_000,
        isFile: true,
      },
      {
        name: "segment-0001.mp3",
        path: "/tmp/segment-0001.mp3",
        mtimeMs: now - 100,
        isFile: true,
      },
    ],
    now,
    false
  );

  assert.deepEqual(segments, [{ index: 0, path: "/tmp/segment-0000.mp3" }]);
});

test("collectSegmentDescriptors includes the newest segment during stop flush", () => {
  const now = 10_000;
  const segments = collectSegmentDescriptors(
    [
      {
        name: "segment-0000.mp3",
        path: "/tmp/segment-0000.mp3",
        mtimeMs: now - 100,
        isFile: true,
      },
    ],
    now,
    true
  );

  assert.deepEqual(segments, [{ index: 0, path: "/tmp/segment-0000.mp3" }]);
});

test("collectSegmentDescriptors accepts wav segments from web capture", () => {
  const now = 10_000;
  const segments = collectSegmentDescriptors(
    [
      {
        name: "segment-0000.wav",
        path: "/tmp/segment-0000.wav",
        mtimeMs: now - 5_000,
        isFile: true,
      },
      {
        name: "segment-0001.wav",
        path: "/tmp/segment-0001.wav",
        mtimeMs: now - 100,
        isFile: true,
      },
    ],
    now,
    false
  );

  assert.deepEqual(segments, [{ index: 0, path: "/tmp/segment-0000.wav" }]);
});
