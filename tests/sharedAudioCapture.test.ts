import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SharedAudioCaptureAdapter } from "../src/infrastructure/adapters/SharedAudioCaptureAdapter";
import { CaptureCancelledError } from "../src/infrastructure/adapters/mediaCaptureErrors";

installDesktopRuntime();

test("SharedAudioCaptureAdapter writes wav segments and final recording from shared audio", async () => {
  installFakeSharedAudioEnvironment({
    getDisplayMedia: async () => new FakeSharedMediaStream(true),
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resonance-shared-capture-"));
  const segmentsDir = path.join(tmpDir, "segments");
  fs.mkdirSync(segmentsDir, { recursive: true });

  const ready: Array<{ index: number; path: string }> = [];
  const adapter = new SharedAudioCaptureAdapter();
  await adapter.start({
    fullAudioPath: path.join(tmpDir, "recording.wav"),
    segmentsDir,
    segmentDurationSeconds: 1,
    onSegmentReady: (segment) => ready.push(segment),
  });

  const processor = FakeAudioContext.lastProcessor;
  assert.ok(processor, "expected the fake script processor to be created");

  processor.emit([
    new Float32Array([0, 0.2, 0.4, 0.6, 0.8, 1]),
    new Float32Array([1, 0.8, 0.6, 0.4, 0.2, 0]),
  ]);
  processor.emit([
    new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5]),
    new Float32Array([0.25, 0.25, 0.25, 0.25, 0.25]),
  ]);

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

test("SharedAudioCaptureAdapter turns share cancellation into CaptureCancelledError", async () => {
  installFakeSharedAudioEnvironment({
    getDisplayMedia: async () => {
      const error = new Error("cancelled");
      Object.assign(error, { name: "AbortError" });
      throw error;
    },
  });

  const adapter = new SharedAudioCaptureAdapter();
  await assert.rejects(
    () =>
      adapter.start({
        fullAudioPath: "/tmp/ignored.wav",
        segmentsDir: "/tmp",
        segmentDurationSeconds: 1,
        onSegmentReady: () => {},
      }),
    CaptureCancelledError
  );
});

test("SharedAudioCaptureAdapter reports a friendly message when the runtime rejects shared audio as unsupported", async () => {
  installFakeSharedAudioEnvironment({
    getDisplayMedia: async () => {
      const error = new Error("Not supported");
      Object.assign(error, { name: "NotSupportedError" });
      throw error;
    },
  });

  const adapter = new SharedAudioCaptureAdapter();
  await assert.rejects(
    () =>
      adapter.start({
        fullAudioPath: "/tmp/ignored.wav",
        segmentsDir: "/tmp",
        segmentDurationSeconds: 1,
        onSegmentReady: () => {},
      }),
    /use loopback device instead/i
  );
});

test("SharedAudioCaptureAdapter fails clearly when the shared surface exposes no audio track", async () => {
  installFakeSharedAudioEnvironment({
    getDisplayMedia: async () => new FakeSharedMediaStream(false),
  });

  const adapter = new SharedAudioCaptureAdapter();
  await assert.rejects(
    () =>
      adapter.start({
        fullAudioPath: "/tmp/ignored.wav",
        segmentsDir: "/tmp",
        segmentDurationSeconds: 1,
        onSegmentReady: () => {},
      }),
    /did not provide an audio track/i
  );
});

function installDesktopRuntime(): void {
  Object.defineProperty(globalThis, "window", {
    value: { require },
    configurable: true,
    writable: true,
  });
}

function installFakeSharedAudioEnvironment(options: {
  getDisplayMedia: (constraints: DisplayMediaStreamOptions) => Promise<FakeSharedMediaStream>;
}): void {
  Object.defineProperty(globalThis, "navigator", {
    value: {
      mediaDevices: {
        getDisplayMedia: options.getDisplayMedia,
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

class FakeSharedMediaStream {
  private readonly audioTracks: FakeMediaStreamTrack[];
  private readonly tracks: FakeMediaStreamTrack[];

  constructor(includeAudioTrack: boolean) {
    const videoTrack = new FakeMediaStreamTrack();
    this.audioTracks = includeAudioTrack ? [new FakeMediaStreamTrack()] : [];
    this.tracks = includeAudioTrack ? [this.audioTracks[0], videoTrack] : [videoTrack];
  }

  getAudioTracks(): MediaStreamTrack[] {
    return this.audioTracks as unknown as MediaStreamTrack[];
  }

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
