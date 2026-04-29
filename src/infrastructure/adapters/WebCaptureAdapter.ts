import { resolvePreferredWebAudioInput, resolveWebAudioInputById } from "../system/webAudio";
import { requireNodeModule } from "../node";
import { StreamingWavWriter, writeWavFile } from "./wavWriter";

export interface WebCaptureSegmentDescriptor {
  index: number;
  path: string;
}

export interface WebCaptureStartOptions {
  fullAudioPath: string;
  segmentsDir: string;
  segmentDurationSeconds: number;
  microphoneDevice?: string;
  additionalSources?: WebCaptureInputSource[];
  onSegmentReady: (segment: WebCaptureSegmentDescriptor) => void;
  onLog?: (line: string) => void;
  onError?: (message: string) => void;
}

export interface WebCaptureInputSource {
  deviceId: string;
  label?: string;
  gain?: number;
}

interface WebAudioContextConstructor {
  new (): AudioContext;
}

export class WebCaptureAdapter {
  private context: AudioContext | null = null;
  private streams: MediaStream[] = [];
  private sourceNodes: MediaStreamAudioSourceNode[] = [];
  private gainNodes: GainNode[] = [];
  private processor: ScriptProcessorNode | null = null;
  private sinkNode: GainNode | null = null;
  private mixBus: GainNode | null = null;
  private segmentBuffers: Float32Array[] = [];
  private segmentSampleCount = 0;
  private segmentTargetSamples = 0;
  private segmentIndex = 0;
  private running = false;
  private sampleRate = 48_000;
  private fullRecordingWriter: StreamingWavWriter | null = null;
  private options: WebCaptureStartOptions | null = null;
  private readonly path = requireNodeModule<{ join: (...parts: string[]) => string }>("path");

  async start(options: WebCaptureStartOptions): Promise<void> {
    if (this.running) {
      throw new Error("Web audio capture already running.");
    }

    const AudioContextCtor = getAudioContextConstructor();
    if (!AudioContextCtor || !globalThis.navigator?.mediaDevices?.getUserMedia) {
      throw new Error("Web Audio capture is not available in this runtime.");
    }

    this.options = options;
    this.segmentBuffers = [];
    this.segmentSampleCount = 0;
    this.segmentIndex = 0;

    const preferredDevice = await resolvePreferredWebAudioInput(options.microphoneDevice);
    const requestedDeviceId = preferredDevice?.deviceId && preferredDevice.deviceId !== "default" ? preferredDevice.deviceId : undefined;
    if (options.microphoneDevice?.trim() && requestedDeviceId !== options.microphoneDevice.trim()) {
      options.onLog?.(`Web Audio fallback: microphone ${options.microphoneDevice.trim()} is unavailable. Using the system default microphone.`);
    }

    const additionalSources = options.additionalSources ?? [];
    const resolvedAdditionalSources = await Promise.all(
      additionalSources.map(async (source) => {
        const resolved = await resolveWebAudioInputById(source.deviceId);
        if (!resolved) {
          throw new Error(
            source.label?.trim()
              ? `Additional audio source "${source.label}" is unavailable. Refresh devices or turn it off.`
              : "The selected additional audio source is unavailable. Refresh devices or turn it off."
          );
        }
        return {
          requested: source,
          resolved,
        };
      })
    );

    if (
      requestedDeviceId &&
      resolvedAdditionalSources.some(({ resolved }) => resolved.deviceId === requestedDeviceId)
    ) {
      throw new Error("The additional audio source must be different from the microphone.");
    }

    try {
      this.streams = [];
      this.streams.push(await globalThis.navigator.mediaDevices.getUserMedia(buildAudioConstraints(requestedDeviceId)));
      for (const source of resolvedAdditionalSources) {
        this.streams.push(await globalThis.navigator.mediaDevices.getUserMedia(buildAudioConstraints(source.resolved.deviceId)));
      }

      this.context = new AudioContextCtor();
      this.sampleRate = this.context.sampleRate || 48_000;
      this.segmentTargetSamples = Math.max(1, Math.floor(this.sampleRate * Math.max(1, options.segmentDurationSeconds)));
      this.fullRecordingWriter = new StreamingWavWriter(options.fullAudioPath, this.sampleRate, 1);
      this.processor = this.context.createScriptProcessor(4096, 2, 1);
      this.mixBus = this.context.createGain();
      this.mixBus.gain.value = 1;
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

      const sourceLabels: string[] = [];
      const sourceConfigs = [
        {
          stream: this.streams[0],
          label: preferredDevice?.label || "System default input",
          gain: 1,
        },
        ...resolvedAdditionalSources.map((source, index) => ({
          stream: this.streams[index + 1],
          label: source.resolved.label || source.requested.label || "Additional source",
          gain: source.requested.gain ?? 1,
        })),
      ];

      for (const config of sourceConfigs) {
        const sourceNode = this.context.createMediaStreamSource(config.stream);
        const gainNode = this.context.createGain();
        gainNode.gain.value = config.gain;
        sourceNode.connect(gainNode);
        gainNode.connect(this.mixBus);
        this.sourceNodes.push(sourceNode);
        this.gainNodes.push(gainNode);
        sourceLabels.push(config.label);
      }

      this.mixBus.connect(this.processor);
      this.processor.connect(this.sinkNode);
      this.sinkNode.connect(this.context.destination);

      this.running = true;
      options.onLog?.(
        `Web Audio capture started: sampleRate=${this.sampleRate}Hz, mixedSources=${sourceConfigs.length}, inputs=${sourceLabels.join(", ")}.`
      );
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
    await this.flushCurrentSegment();
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

  private async flushCurrentSegment(): Promise<void> {
    this.flushCurrentSegmentSync();
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
      this.sourceNodes.forEach((node) => node.disconnect());
    } catch {}
    try {
      this.gainNodes.forEach((node) => node.disconnect());
    } catch {}
    try {
      this.mixBus?.disconnect();
    } catch {}
    try {
      this.processor?.disconnect();
    } catch {}
    try {
      this.sinkNode?.disconnect();
    } catch {}
    try {
      this.streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    } catch {}
    try {
      if (this.context && this.context.state !== "closed") {
        await this.context.close();
      }
    } catch {}

    this.context = null;
    this.streams = [];
    this.sourceNodes = [];
    this.gainNodes = [];
    this.processor = null;
    this.sinkNode = null;
    this.mixBus = null;
    this.fullRecordingWriter = null;
    this.options = null;
    this.running = false;
  }
}

function getAudioContextConstructor(): WebAudioContextConstructor | null {
  const candidate = globalThis.AudioContext ?? ((globalThis as unknown as { webkitAudioContext?: WebAudioContextConstructor }).webkitAudioContext ?? null);
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

function buildAudioConstraints(deviceId?: string): MediaStreamConstraints {
  if (deviceId?.trim()) {
    return {
      audio: {
        deviceId: { exact: deviceId.trim() },
      },
      video: false,
    };
  }

  return {
    audio: true,
    video: false,
  };
}
