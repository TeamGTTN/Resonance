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

  const processor = FakeAudioContext.lastProcessor;
  assert.ok(processor, "expected the fake script processor to be created");

  processor.emit([new Float32Array([0, 0.1, 0.2, 0.3, 0.4, 0.5])]);
  processor.emit([new Float32Array([0.6, 0.7, 0.8, 0.9, 1])]);

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

test("WebCaptureAdapter fails clearly when the additional source is missing", async () => {
  installFakeWebAudioEnvironment();
  const adapter = new WebCaptureAdapter();
  await assert.rejects(
    () =>
      adapter.start({
        fullAudioPath: "/tmp/ignored.wav",
        segmentsDir: "/tmp",
        segmentDurationSeconds: 1,
        additionalSources: [{ deviceId: "missing-loopback", label: "BlackHole 2ch" }],
        onSegmentReady: () => {},
      }),
    /additional audio source/i
  );
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

  Object.defineProperty(globalThis, "navigator", {
    value: {
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
    },
    configurable: true,
    writable: true,
  });

  Object.defineProperty(globalThis, "AudioContext", {
    value: FakeAudioContext,
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

class FakeScriptProcessorNode {
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null = null;

  connect(): void {}
  disconnect(): void {}

  emit(channels: Float32Array[]): void {
    const inputBuffer = new FakeAudioBuffer(channels);
    this.onaudioprocess?.({ inputBuffer } as unknown as AudioProcessingEvent);
  }
}

class FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;

  constructor(private readonly channels: Float32Array[]) {
    this.numberOfChannels = channels.length;
    this.length = channels[0]?.length ?? 0;
  }

  getChannelData(channelIndex: number): Float32Array {
    return this.channels[channelIndex] ?? new Float32Array(this.length);
  }
}

class FakeAudioContext {
  static lastProcessor: FakeScriptProcessorNode | null = null;

  readonly sampleRate = 10;
  readonly destination = {} as AudioDestinationNode;
  state: AudioContextState = "running";

  createMediaStreamSource(): MediaStreamAudioSourceNode {
    return new FakeSourceNode() as unknown as MediaStreamAudioSourceNode;
  }

  createScriptProcessor(): ScriptProcessorNode {
    const processor = new FakeScriptProcessorNode();
    FakeAudioContext.lastProcessor = processor;
    return processor as unknown as ScriptProcessorNode;
  }

  createGain(): GainNode {
    return new FakeGainNode() as unknown as GainNode;
  }

  async close(): Promise<void> {
    this.state = "closed";
  }
}
