import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StreamingWavWriter, createWavHeader, writeWavFile } from "../src/infrastructure/adapters/wavWriter";

installDesktopRuntime();

test("createWavHeader writes a valid RIFF/WAVE header", () => {
  const header = createWavHeader(1_600, 16_000, 1);

  assert.equal(header.length, 44);
  assert.equal(header.toString("ascii", 0, 4), "RIFF");
  assert.equal(header.toString("ascii", 8, 12), "WAVE");
  assert.equal(header.toString("ascii", 12, 16), "fmt ");
  assert.equal(header.toString("ascii", 36, 40), "data");
  assert.equal(header.readUInt32LE(4), 1_636);
  assert.equal(header.readUInt32LE(24), 16_000);
  assert.equal(header.readUInt16LE(22), 1);
  assert.equal(header.readUInt32LE(40), 1_600);
});

test("writeWavFile writes PCM data after the header", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resonance-wav-file-"));
  const filePath = path.join(tmpDir, "segment.wav");
  writeWavFile(filePath, new Float32Array([0, 0.5, -0.5, 1]), 16_000, 1);

  const buffer = fs.readFileSync(filePath);
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.readUInt32LE(40), 8);
  assert.equal(buffer.length, 52);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("StreamingWavWriter patches the header with the final data size", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resonance-wav-stream-"));
  const filePath = path.join(tmpDir, "recording.wav");
  const writer = new StreamingWavWriter(filePath, 48_000, 1);

  writer.append(new Float32Array([0.25, -0.25]));
  writer.append(new Float32Array([0.5, -0.5, 0]));
  writer.finalize();

  const buffer = fs.readFileSync(filePath);
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.readUInt32LE(40), 10);
  assert.equal(buffer.readUInt32LE(4), 46);
  assert.equal(buffer.length, 54);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function installDesktopRuntime(): void {
  const desktopWindow = {
    require: require,
  };
  Object.defineProperty(globalThis, "window", {
    value: desktopWindow,
    configurable: true,
    writable: true,
  });
}
