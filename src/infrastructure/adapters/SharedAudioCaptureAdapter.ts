import { requireNodeModule } from "../node";
import {
  CaptureCancelledError,
  getSharedAudioCaptureFailureDetail,
  isDisplayShareCancellation,
} from "./mediaCaptureErrors";
import { StreamingWavWriter, writeWavFile } from "./wavWriter";

export interface SharedAudioSegmentDescriptor {
  index: number;
  path: string;
}

export interface SharedAudioCaptureStartOptions {
  fullAudioPath: string;
  segmentsDir: string;
  segmentDurationSeconds: number;
  onSegmentReady: (segment: SharedAudioSegmentDescriptor) => void;
  onLog?: (line: string) => void;
  onError?: (message: string) => void;
}

interface WebAudioContextConstructor {
  new (): AudioContext;
}

export class SharedAudioCaptureAdapter {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sinkNode: GainNode | null = null;
  private segmentBuffers: Float32Array[] = [];
  private segmentSampleCount = 0;
  private segmentTargetSamples = 0;
  private segmentIndex = 0;
  private running = false;
  private sampleRate = 48_000;
  private fullRecordingWriter: StreamingWavWriter | null = null;
  private options: SharedAudioCaptureStartOptions | null = null;
  private readonly path = requireNodeModule<{ join: (...parts: string[]) => string }>("path");

  async start(options: SharedAudioCaptureStartOptions): Promise<void> {
    if (this.running) {
      throw new Error("Shared audio capture already running.");
    }

    const AudioContextCtor = getAudioContextConstructor();
    if (!AudioContextCtor || !globalThis.navigator?.mediaDevices?.getDisplayMedia) {
      throw new Error("Shared system audio capture is not available in this runtime.");
    }

    this.options = options;
    this.segmentBuffers = [];
    this.segmentSampleCount = 0;
    this.segmentIndex = 0;

    try {
      this.stream = await globalThis.navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
    } catch (error) {
      if (isDisplayShareCancellation(error)) {
        throw new CaptureCancelledError("Shared audio capture was canceled.");
      }
      const detail = getSharedAudioCaptureFailureDetail(error);
      if (detail) {
        throw new Error(detail);
      }
      throw error;
    }

    if (!this.stream.getAudioTracks().length) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
      throw new Error("The shared surface did not provide an audio track. Choose a surface that shares audio or use Loopback device instead.");
    }

    try {
      this.context = new AudioContextCtor();
      this.sampleRate = this.context.sampleRate || 48_000;
      this.segmentTargetSamples = Math.max(1, Math.floor(this.sampleRate * Math.max(1, options.segmentDurationSeconds)));
      this.fullRecordingWriter = new StreamingWavWriter(options.fullAudioPath, this.sampleRate, 1);
      this.sourceNode = this.context.createMediaStreamSource(this.stream);
      this.processor = this.context.createScriptProcessor(4096, 1, 1);
      this.sinkNode = this.context.createGain();
      this.sinkNode.gain.value = 0;
      this.processor.onaudioprocess = (event) => {
        try {
          this.handleAudioProcess(event);
        } catch (error) {
          const message = String((error as Error)?.message ?? error);
          this.options?.onError?.(message);
        }
      };

      this.sourceNode.connect(this.processor);
      this.processor.connect(this.sinkNode);
      this.sinkNode.connect(this.context.destination);

      this.running = true;
      options.onLog?.(`Shared audio capture started: sampleRate=${this.sampleRate}Hz, channelCount=1.`);
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.processor && (this.processor.onaudioprocess = null);
    this.flushCurrentSegmentSync();
    this.fullRecordingWriter?.finalize();
    await this.dispose();
  }

  private handleAudioProcess(event: AudioProcessingEvent): void {
    if (!this.running || !this.options) return;

    const monoSamples = extractMonoSamples(event.inputBuffer);
    if (monoSamples.length === 0) return;
    this.fullRecordingWriter?.append(monoSamples);

    let offset = 0;
    while (offset < monoSamples.length) {
      const remainingInSegment = this.segmentTargetSamples - this.segmentSampleCount;
      const take = Math.min(remainingInSegment, monoSamples.length - offset);
      const chunk = monoSamples.slice(offset, offset + take);
      this.segmentBuffers.push(chunk);
      this.segmentSampleCount += take;
      offset += take;

      if (this.segmentSampleCount >= this.segmentTargetSamples) {
        this.flushCurrentSegmentSync();
      }
    }
  }

  private flushCurrentSegmentSync(): void {
    if (!this.options || this.segmentSampleCount === 0) return;

    const samples = concatFloat32Arrays(this.segmentBuffers, this.segmentSampleCount);
    const segmentPath = this.path.join(this.options.segmentsDir, `segment-${String(this.segmentIndex).padStart(4, "0")}.wav`);
    writeWavFile(segmentPath, samples, this.sampleRate, 1);
    this.options.onSegmentReady({ index: this.segmentIndex, path: segmentPath });
    this.segmentIndex += 1;
    this.segmentBuffers = [];
    this.segmentSampleCount = 0;
  }

  private async dispose(): Promise<void> {
    try {
      this.sourceNode?.disconnect();
    } catch {}
    try {
      this.processor?.disconnect();
    } catch {}
    try {
      this.sinkNode?.disconnect();
    } catch {}
    try {
      this.stream?.getTracks().forEach((track) => track.stop());
    } catch {}
    try {
      if (this.context && this.context.state !== "closed") {
        await this.context.close();
      }
    } catch {}

    this.context = null;
    this.stream = null;
    this.sourceNode = null;
    this.processor = null;
    this.sinkNode = null;
    this.fullRecordingWriter = null;
    this.options = null;
    this.running = false;
  }
}

function getAudioContextConstructor(): WebAudioContextConstructor | null {
  const candidate =
    globalThis.AudioContext ??
    ((globalThis as unknown as { webkitAudioContext?: WebAudioContextConstructor }).webkitAudioContext ?? null);
  return candidate ?? null;
}

function extractMonoSamples(buffer: AudioBuffer): Float32Array {
  const channels = Math.max(1, buffer.numberOfChannels);
  const output = new Float32Array(buffer.length);

  if (channels === 1) {
    output.set(buffer.getChannelData(0));
    return output;
  }

  for (let sampleIndex = 0; sampleIndex < buffer.length; sampleIndex += 1) {
    let sum = 0;
    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      sum += buffer.getChannelData(channelIndex)[sampleIndex] ?? 0;
    }
    output[sampleIndex] = sum / channels;
  }

  return output;
}

function concatFloat32Arrays(chunks: Float32Array[], totalLength: number): Float32Array {
  const output = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
