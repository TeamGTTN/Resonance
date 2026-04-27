// DeviceScanner: utility to query FFmpeg and extract device names.
// It invokes ffmpeg with device-list arguments for supported backends.

export interface ListedDevice {
  backend: string; // dshow | avfoundation | pulse | alsa
  type: 'audio' | 'video' | 'unknown';
  name: string; // string to use as ffmpeg spec (e.g., audio=Microphone (...) for dshow; :0 for avfoundation audio)
  label: string; // human-readable label
}

export async function scanDevices(ffmpegPath: string, backend: 'dshow' | 'avfoundation' | 'pulse' | 'alsa'): Promise<ListedDevice[]> {
  if (!ffmpegPath) throw new Error('FFmpeg path not configured');
  const { spawn } = (window as any).require('child_process');

  const args = backend === 'dshow'
    ? ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']
    : backend === 'avfoundation'
    ? ['-f', 'avfoundation', '-list_devices', 'true', '-i', '']
    : backend === 'pulse'
    ? ['-f', 'pulse', '-sources', 'pulse']
    : ['-f', 'alsa', '-sources', 'alsa'];

  const stderr = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const child = spawn(ffmpegPath, args);
    child.stdout?.on('data', (d: Buffer) => { buf += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { buf += d.toString(); });
    child.on('error', (e: any) => reject(e));
    child.on('close', () => resolve(buf));
  });

  return parseFfmpegDeviceList(stderr, backend);
}

function parseFfmpegDeviceList(output: string, backend: 'dshow' | 'avfoundation' | 'pulse' | 'alsa'): ListedDevice[] {
  const devices: ListedDevice[] = [];
  const lines = output.split(/\r?\n/);

  if (backend === 'dshow') {
    let section: 'audio' | 'video' | 'unknown' = 'unknown';
    for (const raw of lines) {
      const line = raw.trim();
      if (/DirectShow audio devices/i.test(line)) { section = 'audio'; continue; }
      if (/DirectShow video devices/i.test(line)) { section = 'video'; continue; }
      // Salta i nomi alternativi tipo: Alternative name "@device_sw_{GUID}..."
      if (/Alternative name\s+"/.test(line)) continue;
      const m = line.match(/\s*"(.+?)"/);
      if (m) {
        const label = m[1];
        if (/^@device_/i.test(label)) continue; // evita GUID poco usabili
        const type: 'audio' | 'video' | 'unknown' = section;
        const name = type === 'audio' ? `audio=${label}` : label;
        devices.push({ backend, type, name, label });
      }
    }
    // de-duplica per etichetta
    const seen = new Set<string>();
    return devices.filter(d => { const k = `${d.type}|${d.label}`; if (seen.has(k)) return false; seen.add(k); return true; });
  } else if (backend === 'avfoundation') {
    // Esempio:
    // AVFoundation video devices:
    // [0] FaceTime HD Camera
    // AVFoundation audio devices:
    // [0] Built-in Microphone
    let section: 'audio' | 'video' | 'unknown' = 'unknown';
    for (const line of lines) {
      if (/AVFoundation video devices/i.test(line)) section = 'video';
      else if (/AVFoundation audio devices/i.test(line)) section = 'audio';
      const m = line.match(/\[(\d+)\]\s+(.+)/);
      if (m) {
        const idx = m[1];
        const label = m[2];
        const type: 'audio' | 'video' | 'unknown' = section;
        const name = section === 'audio' ? `:${idx}` : `${idx}:`;
        devices.push({ backend, type, name, label: `${idx}: ${label}` });
      }
    }
  } else {
    // pulse/alsa — parser basilare
    devices.push({ backend, type: 'audio', name: 'default', label: 'default' });
  }
  return devices;
}
