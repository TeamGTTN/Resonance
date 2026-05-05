import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebCaptureAdapter } from "../src/infrastructure/adapters/WebCaptureAdapter";

installDesktopRuntime();

let requestedConstraints: MediaStreamConstraints[] = [];

test("WebCaptureAdapter writes wav segments and final recording without polling", async () => {
  installFakeWebAudioEnvironment();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resonance-web-capture-"));
  const segmentsDir = path.join(tmpDir, "segments");
  fs.mkdirSync(segmentsDir, { recursive: true });

  const ready: Array<{ index: number; path: string }> = [];
  const adapter = new WebCaptureAdapter();
  await adapter.start({
    fullAudioPath: path.join(tmpDir, "recording.wav"),
    segmentsDir,
    segmentDurationSeconds: 1,
    microphoneDevice: "mic-1",
    onSegmentReady: (segment) => ready.push(segment),
  });

  const worklet = FakeAudioWorkletNode.lastNode;
  assert.ok(worklet, "expected the fake AudioWorklet node to be created");

  worklet.emit([new Float32Array([0, 0.1, 0.2, 0.3, 0.4, 0.5])]);
  worklet.emit([new Float32Array([0.6, 0.7, 0.8, 0.9, 1])]);

  await adapter.stop();

  assert.deepEqual(
    ready.map((segment) => segment.index),
    [0, 1]
  );
  assert.equal(fs.existsSync(path.join(tmpDir, "recording.wav")), true);
  assert.equal(fs.existsSync(path.join(segmentsDir, "segment-0000.wav")), true);
  assert.equal(fs.existsSync(path.join(segmentsDir, "segment-0001.wav")), true);
  assert.equal(fs.readFileSync(path.join(segmentsDir, "segment-0000.wav")).readUInt32LE(40), 20);
  assert.equal(fs.readFileSync(path.join(segmentsDir, "segment-0001.wav")).readUInt32LE(40), 2);
  assert.equal(fs.readFileSync(path.join(tmpDir, "recording.wav")).readUInt32LE(40), 22);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("WebCaptureAdapter falls back to the default microphone when the saved device is missing", async () => {
  installFakeWebAudioEnvironment();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resonance-web-fallback-"));
  const segmentsDir = path.join(tmpDir, "segments");
  fs.mkdirSync(segmentsDir, { recursive: true });
  const logs: string[] = [];

  const adapter = new WebCaptureAdapter();
  await adapter.start({
    fullAudioPath: path.join(tmpDir, "recording.wav"),
    segmentsDir,
    segmentDurationSeconds: 1,
    microphoneDevice: "missing-device",
    onSegmentReady: () => {},
    onLog: (line) => logs.push(line),
  });

  const lastConstraints = requestedConstraints[requestedConstraints.length - 1] ?? null;
  const requestedAudio =
    lastConstraints && lastConstraints.audio && lastConstraints.audio !== true ? lastConstraints.audio : undefined;
  assert.equal(typeof requestedAudio?.deviceId, "undefined");
  assert.ok(logs.some((line) => line.includes("fallback")), "expected a fallback log when the saved device is missing");

  await adapter.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("WebCaptureAdapter opens a second Web Audio input when an additional source is configured", async () => {
  installFakeWebAudioEnvironment();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resonance-web-dual-input-"));
  const segmentsDir = path.join(tmpDir, "segments");
  fs.mkdirSync(segmentsDir, { recursive: true });

  const adapter = new WebCaptureAdapter();
  await adapter.start({
    fullAudioPath: path.join(tmpDir, "recording.wav"),
    segmentsDir,
    segmentDurationSeconds: 1,
    microphoneDevice: "mic-1",
    additionalSources: [{ deviceId: "loopback-1", label: "BlackHole 2ch" }],
    onSegmentReady: () => {},
  });

  assert.equal(requestedConstraints.length, 2);
  const micConstraints = requestedConstraints[0]?.audio;
  const systemConstraints = requestedConstraints[1]?.audio;
  assert.deepEqual(micConstraints, { deviceId: { exact: "mic-1" } });
  assert.deepEqual(systemConstraints, { deviceId: { exact: "loopback-1" } });

  await adapter.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("WebCaptureAdapter skips missing additional sources and continues recording", async () => {
  installFakeWebAudioEnvironment();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resonance-web-missing-source-"));
  const segmentsDir = path.join(tmpDir, "segments");
  fs.mkdirSync(segmentsDir, { recursive: true });
  const logs: string[] = [];

  const adapter = new WebCaptureAdapter();
  await adapter.start({
    fullAudioPath: path.join(tmpDir, "recording.wav"),
    segmentsDir,
    segmentDurationSeconds: 1,
    additionalSources: [{ deviceId: "missing-loopback", label: "BlackHole 2ch" }],
    onSegmentReady: () => {},
    onLog: (line) => logs.push(line),
  });

  assert.equal(requestedConstraints.length, 1);
  assert.ok(logs.some((line) => line.includes("unavailable")));

  await adapter.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("WebCaptureAdapter skips duplicated additional sources", async () => {
  installFakeWebAudioEnvironment();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resonance-web-duplicate-source-"));
  const segmentsDir = path.join(tmpDir, "segments");
  fs.mkdirSync(segmentsDir, { recursive: true });
  const logs: string[] = [];

  const adapter = new WebCaptureAdapter();
  await adapter.start({
    fullAudioPath: path.join(tmpDir, "recording.wav"),
    segmentsDir,
    segmentDurationSeconds: 1,
    microphoneDevice: "mic-1",
    additionalSources: [
      { deviceId: "loopback-1", label: "BlackHole 2ch" },
      { deviceId: "loopback-1", label: "BlackHole 2ch" },
      { deviceId: "mic-1", label: "USB Microphone" },
    ],
    onSegmentReady: () => {},
    onLog: (line) => logs.push(line),
  });

  assert.equal(requestedConstraints.length, 2);
  assert.ok(logs.some((line) => line.includes("duplicated")));
  assert.ok(logs.some((line) => line.includes("matches the selected microphone")));

  await adapter.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function installDesktopRuntime(): void {
  Object.defineProperty(globalThis, "window", {
    value: { require },
    configurable: true,
    writable: true,
  });
}

function installFakeWebAudioEnvironment(): void {
  requestedConstraints = [];
  FakeAudioWorkletNode.lastNode = null;

  const navigatorValue = {
    mediaDevices: {
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        requestedConstraints.push(constraints);
        return new FakeMediaStream();
      },
      enumerateDevices: async () =>
        [
          {
            kind: "audioinput",
            deviceId: "default",
            label: "System default microphone",
            groupId: "default-group",
          },
          {
            kind: "audioinput",
            deviceId: "mic-1",
            label: "USB Microphone",
            groupId: "group-1",
          },
          {
            kind: "audioinput",
            deviceId: "loopback-1",
            label: "BlackHole 2ch",
            groupId: "group-2",
          },
        ] as MediaDeviceInfo[],
    },
    permissions: {
      query: async () => ({ state: "prompt" }),
    },
  } as unknown as Navigator;

  Object.defineProperty(globalThis, "window", {
    value: {
      require,
      navigator: navigatorValue,
      AudioContext: FakeAudioContext,
      URL: {
        createObjectURL: () => "blob:fake-worklet",
        revokeObjectURL: () => {},
      },
      setTimeout,
      clearTimeout,
    },
    configurable: true,
    writable: true,
  });

  Object.defineProperty(globalThis, "navigator", {
    value: navigatorValue,
    configurable: true,
    writable: true,
  });

  Object.defineProperty(globalThis, "AudioWorkletNode", {
    value: FakeAudioWorkletNode,
    configurable: true,
    writable: true,
  });
}

class FakeMediaStream {
  private readonly tracks = [new FakeMediaStreamTrack()];

  getTracks(): MediaStreamTrack[] {
    return this.tracks as unknown as MediaStreamTrack[];
  }
}

class FakeMediaStreamTrack {
  stop(): void {}
}

class FakeSourceNode {
  connect(): void {}
  disconnect(): void {}
}

class FakeGainNode {
  gain = { value: 1 };

  connect(): void {}
  disconnect(): void {}
}

class FakeMessagePort {
  onmessage: ((event: MessageEvent<Float32Array>) => void) | null = null;

  close(): void {
    this.onmessage = null;
  }

  emit(samples: Float32Array): void {
    this.onmessage?.({ data: samples } as MessageEvent<Float32Array>);
  }
}

class FakeAudioWorkletNode {
  static lastNode: FakeAudioWorkletNode | null = null;

  readonly port = new FakeMessagePort();

  constructor() {
    FakeAudioWorkletNode.lastNode = this;
  }

  connect(): void {}
  disconnect(): void {}

  emit(channels: Float32Array[]): void {
    const length = channels[0]?.length ?? 0;
    const samples = new Float32Array(length);
    for (let sampleIndex = 0; sampleIndex < length; sampleIndex += 1) {
      let sum = 0;
      for (const channel of channels) {
        sum += channel[sampleIndex] ?? 0;
      }
      samples[sampleIndex] = channels.length > 0 ? sum / channels.length : 0;
    }
    this.port.emit(samples);
  }
}

class FakeAudioContext {
  readonly audioWorklet = {
    addModule: async () => {},
  };
  readonly sampleRate = 10;
  readonly destination = {} as AudioDestinationNode;
  state: AudioContextState = "running";

  createMediaStreamSource(): MediaStreamAudioSourceNode {
    return new FakeSourceNode() as unknown as MediaStreamAudioSourceNode;
  }

  createGain(): GainNode {
    return new FakeGainNode() as unknown as GainNode;
  }

  async close(): Promise<void> {
    this.state = "closed";
  }
}
