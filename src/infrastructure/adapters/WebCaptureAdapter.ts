import {
  resolvePreferredWebAudioInput,
  resolveWebAudioInputById,
  type WebAudioInputDevice,
} from "../system/webAudio";
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

const AUDIO_WORKLET_PROCESSOR_NAME = "resonance-mix-processor";
const AUDIO_WORKLET_SOURCE = `
class ResonanceMixProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const channels = inputs[0] || [];
    const length = channels[0]?.length || 0;
    if (length > 0) {
      const mono = new Float32Array(length);
      for (let sampleIndex = 0; sampleIndex < length; sampleIndex += 1) {
        let sum = 0;
        for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
          sum += channels[channelIndex]?.[sampleIndex] || 0;
        }
        mono[sampleIndex] = channels.length > 0 ? sum / channels.length : 0;
      }
      this.port.postMessage(mono, [mono.buffer]);
    }

    const output = outputs[0] || [];
    for (const channel of output) {
      channel.fill(0);
    }
    return true;
  }
}

registerProcessor("${AUDIO_WORKLET_PROCESSOR_NAME}", ResonanceMixProcessor);
`;

export class WebCaptureAdapter {
  private context: AudioContext | null = null;
  private streams: MediaStream[] = [];
  private sourceNodes: MediaStreamAudioSourceNode[] = [];
  private gainNodes: GainNode[] = [];
  private workletNode: AudioWorkletNode | null = null;
  private workletModuleUrl: string | null = null;
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
    const browserNavigator = getBrowserNavigator();
    if (!AudioContextCtor || !browserNavigator?.mediaDevices?.getUserMedia) {
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
    const resolvedAdditionalSources: Array<{
      requested: WebCaptureInputSource;
      resolved: WebAudioInputDevice;
    }> = [];
    const seenAdditionalIds = new Set<string>();
    for (const source of additionalSources) {
      if (!source.deviceId.trim()) continue;
      if (requestedDeviceId && source.deviceId === requestedDeviceId) {
        options.onLog?.(
          source.label?.trim()
            ? `Web Audio skip: additional source "${source.label}" matches the selected microphone.`
            : "Web Audio skip: additional source matches the selected microphone."
        );
        continue;
      }
      if (seenAdditionalIds.has(source.deviceId)) {
        options.onLog?.(
          source.label?.trim()
            ? `Web Audio skip: additional source "${source.label}" is duplicated.`
            : "Web Audio skip: duplicated additional source."
        );
        continue;
      }
      const resolved = await resolveWebAudioInputById(source.deviceId);
      if (!resolved) {
        options.onLog?.(
          source.label?.trim()
            ? `Web Audio skip: additional source "${source.label}" is unavailable.`
            : "Web Audio skip: selected additional source is unavailable."
        );
        continue;
      }
      seenAdditionalIds.add(source.deviceId);
      resolvedAdditionalSources.push({
        requested: source,
        resolved,
      });
    }

    try {
      this.streams = [];
      this.streams.push(await browserNavigator.mediaDevices.getUserMedia(buildAudioConstraints(requestedDeviceId)));
      for (const source of resolvedAdditionalSources) {
        this.streams.push(await browserNavigator.mediaDevices.getUserMedia(buildAudioConstraints(source.resolved.deviceId)));
      }

      this.context = new AudioContextCtor();
      await this.installAudioWorklet(this.context);
      this.sampleRate = this.context.sampleRate || 48_000;
      this.segmentTargetSamples = Math.max(1, Math.floor(this.sampleRate * Math.max(1, options.segmentDurationSeconds)));
      this.fullRecordingWriter = new StreamingWavWriter(options.fullAudioPath, this.sampleRate, 1);
      this.workletNode = new AudioWorkletNode(this.context, AUDIO_WORKLET_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.mixBus = this.context.createGain();
      this.mixBus.gain.value = 1;
      this.sinkNode = this.context.createGain();
      this.sinkNode.gain.value = 0;
      this.workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
        try {
          this.handleAudioChunk(event.data);
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

      this.mixBus.connect(this.workletNode);
      this.workletNode.connect(this.sinkNode);
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
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
    }
    this.flushCurrentSegmentSync();
    this.fullRecordingWriter?.finalize();
    await this.dispose();
  }

  private handleAudioChunk(monoSamples: Float32Array): void {
    if (!this.running || !this.options) return;

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

  private async installAudioWorklet(context: AudioContext): Promise<void> {
    if (!context.audioWorklet?.addModule) {
      throw new Error("AudioWorklet is not available in this runtime.");
    }
    const blob = new Blob([AUDIO_WORKLET_SOURCE], { type: "application/javascript" });
    this.workletModuleUrl = window.URL.createObjectURL(blob);
    await context.audioWorklet.addModule(this.workletModuleUrl);
  }

  private async dispose(): Promise<void> {
    try {
      this.sourceNodes.forEach((node) => node.disconnect());
    } catch {
      // Source nodes may already be disconnected during browser teardown.
    }
    try {
      this.gainNodes.forEach((node) => node.disconnect());
    } catch {
      // Gain nodes may already be disconnected during browser teardown.
    }
    try {
      this.mixBus?.disconnect();
    } catch {
      // The mix bus may already be disconnected after a failed start.
    }
    try {
      this.workletNode?.disconnect();
      this.workletNode?.port.close();
    } catch {
      // Worklet teardown can race with AudioContext closure.
    }
    try {
      this.sinkNode?.disconnect();
    } catch {
      // The silent sink may already be disconnected after a failed start.
    }
    try {
      this.streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    } catch {
      // Tracks may already be stopped by the OS or browser.
    }
    try {
      if (this.context && this.context.state !== "closed") {
        await this.context.close();
      }
    } catch {
      // AudioContext closure is best effort during plugin shutdown.
    }
    if (this.workletModuleUrl) {
      window.URL.revokeObjectURL(this.workletModuleUrl);
    }

    this.context = null;
    this.streams = [];
    this.sourceNodes = [];
    this.gainNodes = [];
    this.workletNode = null;
    this.workletModuleUrl = null;
    this.sinkNode = null;
    this.mixBus = null;
    this.fullRecordingWriter = null;
    this.options = null;
    this.running = false;
  }
}

function getAudioContextConstructor(): WebAudioContextConstructor | null {
  if (typeof window === "undefined") return null;
  const candidate = window.AudioContext ?? ((window as unknown as { webkitAudioContext?: WebAudioContextConstructor }).webkitAudioContext ?? null);
  return candidate ?? null;
}

function getBrowserNavigator(): Navigator | undefined {
  return typeof window === "undefined" ? undefined : window.navigator;
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
