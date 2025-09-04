// This module provides functions for automatically detecting the paths of FFmpeg and whisper.cpp executables
// across different operating systems. Specifically, it attempts to locate FFmpeg using system commands
// ('which' on Unix/macOS, 'where' on Windows) and, if unsuccessful, checks several known common locations
// for each system. Additionally, it offers a function to detect the main whisper.cpp executable
// starting from the repository folder, verifying the presence of executable files in typical subfolders.

export async function autoDetectFfmpeg(): Promise<string | null> {
  try {
    const { spawn } = (window as any).require('child_process');
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const found = await new Promise<string | null>((resolve) => {
      try {
        const child = spawn(cmd, ['ffmpeg']);
        let out = '';
        child.stdout?.on('data', (d: Buffer) => out += d.toString());
        child.on('close', () => {
          const line = out.split(/\r?\n/).map(s=>s.trim()).find(Boolean);
          resolve(line || null);
        });
        child.on('error', () => resolve(null));
      } catch {
        resolve(null);
      }
    });
    if (found) return found;
  } catch {}

  try {
    const fs = (window as any).require('fs');
    if (process.platform === 'win32') {
      const candidates = [
        'C:/ffmpeg/bin/ffmpeg.exe',
        'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
        'C:/Program Files (x86)/ffmpeg/bin/ffmpeg.exe',
        'C:/ProgramData/chocolatey/bin/ffmpeg.exe',
        'C:/ProgramData/chocolatey/lib/ffmpeg/tools/ffmpeg.exe',
      ];
      for (const c of candidates) { if (fs.existsSync(c)) return c; }
    } else {
      const candidates = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
      for (const c of candidates) { if (fs.existsSync(c)) return c; }
    }
  } catch {}
  return null;
}

export async function autoDetectWhisperFromRepo(repoPath: string | undefined | null): Promise<string | null> {
  try {
    if (!repoPath) return null;
    const path = (window as any).require('path');
    const fs = (window as any).require('fs');
    const isExe = (p: string) => { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } };
    const candidates = [
      ['build','bin','whisper-cli'],
      ['build','bin','whisper-cli.exe'],
      ['build','bin','Release','whisper-cli'],
      ['build','bin','Release','whisper-cli.exe'],
      ['main'],
      ['main.exe'],
    ].map(parts => path.join(repoPath, ...parts));
    for (const c of candidates) if (isExe(c)) return c;

    // shallow walk (max depth 3)
    const maxDepth = 3;
    const found = walkFind(repoPath, (p)=>/whisper-cli(\.exe)?$/i.test(p), maxDepth);
    if (found) return found;
  } catch {}
  return null;
}

function walkFind(root: string, match: (p:string)=>boolean, depth: number): string | null {
  try {
    const fs = (window as any).require('fs');
    const path = (window as any).require('path');
    if (depth < 0) return null;
    const items = fs.readdirSync(root);
    for (const name of items) {
      const full = path.join(root, name);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile() && match(full)) return full;
        if (stat.isDirectory()) {
          const r = walkFind(full, match, depth - 1);
          if (r) return r;
        }
      } catch {}
    }
  } catch {}
  return null;
}


