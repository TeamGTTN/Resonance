import { requireNodeModule } from "../node";

interface FsModule {
  closeSync: (fd: number) => void;
  openSync: (path: string, flags: string) => number;
  writeFileSync: (path: string, data: Buffer) => void;
  writeSync: (fd: number, buffer: Buffer, offset?: number, length?: number, position?: number) => number;
}

const WAV_HEADER_BYTES = 44;
const PCM_SAMPLE_BYTES = 2;

export function createWavHeader(dataSize: number, sampleRate: number, channels: number): Buffer {
  const blockAlign = channels * PCM_SAMPLE_BYTES;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(WAV_HEADER_BYTES);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);

  return header;
}

export function writeWavFile(filePath: string, samples: Float32Array, sampleRate: number, channels: number): void {
  const fs = requireNodeModule<FsModule>("fs");
  const pcm = encodePcm16(samples);
  const header = createWavHeader(pcm.length, sampleRate, channels);
  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
}

export class StreamingWavWriter {
  private readonly fs = requireNodeModule<FsModule>("fs");
  private readonly fd: number;
  private dataSize = 0;
  private finalized = false;

  constructor(
    private readonly filePath: string,
    private readonly sampleRate: number,
    private readonly channels: number
  ) {
    this.fd = this.fs.openSync(filePath, "w");
    this.fs.writeSync(this.fd, createWavHeader(0, sampleRate, channels));
  }

  append(samples: Float32Array): void {
    if (this.finalized || samples.length === 0) return;
    const pcm = encodePcm16(samples);
    if (pcm.length === 0) return;
    this.fs.writeSync(this.fd, pcm);
    this.dataSize += pcm.length;
  }

  finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    const header = createWavHeader(this.dataSize, this.sampleRate, this.channels);
    this.fs.writeSync(this.fd, header, 0, WAV_HEADER_BYTES, 0);
    this.fs.closeSync(this.fd);
  }

  getPath(): string {
    return this.filePath;
  }
}

function encodePcm16(samples: Float32Array): Buffer {
  const buffer = Buffer.alloc(samples.length * PCM_SAMPLE_BYTES);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    const value = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    buffer.writeInt16LE(value, index * PCM_SAMPLE_BYTES);
  }
  return buffer;
}
