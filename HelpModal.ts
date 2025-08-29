import { App, Modal } from "obsidian";

export type HelpTopic = 'ffmpeg' | 'whisper' | 'llm' | 'devices' | 'obsidian';

export class HelpModal extends Modal {
  private topic: HelpTopic;

  constructor(app: App, topic: HelpTopic) {
    super(app);
    this.topic = topic;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('resonance-modal');

    const title = {
      ffmpeg: 'FFmpeg setup guide',
      whisper: 'Whisper.cpp setup guide',
      llm: 'LLM (Gemini) setup guide',
      devices: 'Audio devices guide (FFmpeg)',
      obsidian: 'Obsidian setup guide',
    }[this.topic];

    contentEl.createEl('h2', { text: title });
    const body = contentEl.createEl('div', { cls: 'resonance-help' });

    const sections = this.getContent(this.topic);
    sections.forEach(sec => {
      body.createEl('h3', { text: sec.title });
      sec.paragraphs.forEach(p => body.createEl('p', { text: p }));
      if (sec.code) {
        const pre = body.createEl('pre');
        pre.style.position = 'relative';
        const code = pre.createEl('code');
        const codeText = sec.code.trim();
        code.innerText = codeText;
        const copyBtn = pre.createEl('button', { cls: 'resonance-btn secondary small', text: 'Copy' });
        copyBtn.style.position = 'absolute';
        copyBtn.style.top = '6px';
        copyBtn.style.right = '6px';
        copyBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(codeText);
            copyBtn.textContent = 'Copied!';
            setTimeout(()=> copyBtn.textContent = 'Copy', 1200);
          } catch {
            copyBtn.textContent = 'Failed';
            setTimeout(()=> copyBtn.textContent = 'Copy', 1200);
          }
        });
      }
    });
  }

  private getContent(topic: HelpTopic): { title: string; paragraphs: string[]; code?: string }[] {
    switch (topic) {
      case 'ffmpeg':
        return [
          { title: 'What is FFmpeg', paragraphs: [
            'FFmpeg is a cross‑platform tool to capture, convert and process audio/video.',
            'Resonance uses FFmpeg to record the microphone and (optionally) system audio.'
          ]},
          { title: 'macOS', paragraphs: [
            'Install Xcode Command Line Tools and Homebrew, then install FFmpeg with the following commands.',
          ], code: 'brew install ffmpeg' },
          { title: 'Windows', paragraphs: [
            'Download a static build from the official website, extract it, then point to ffmpeg.exe.',
            'Alternatively, if you use Chocolatey: choco install ffmpeg.',
          ], code: 'C:/ffmpeg/bin/ffmpeg.exe\n:: or\nchoco install ffmpeg' },
          { title: 'Linux', paragraphs: [
            'Install FFmpeg from your package manager (Debian/Ubuntu, Fedora, Arch examples).',
          ], code: 'sudo apt update && sudo apt install -y ffmpeg\n# Fedora/RHEL\nsudo dnf install -y ffmpeg\n# Arch\nsudo pacman -S ffmpeg' },
        ];
      case 'whisper':
        return [
          { title: 'What is whisper.cpp', paragraphs: [
            'whisper.cpp is a local speech‑to‑text engine; Resonance runs it on your machine.',
            'You must set the repo path and choose/download a model (.bin).'
          ]},
          { title: 'macOS', paragraphs: [
            'Clone the repo and build with make; models go into whisper.cpp/models/.',
            'In Settings → Resonance, set the whisper.cpp repo path and the whisper-cli executable.',
            'In Settings → Resonance, select and download the model you prefer.'
          ], code: 'git clone https://github.com/ggerganov/whisper.cpp\ncd whisper.cpp\nmake -j' },
          { title: 'Windows', paragraphs: [
            'Clone the repo; build with CMake/Visual Studio in Release; models in whisper.cpp\\models\\.',
            'In Settings → Resonance, set the whisper.cpp repo path and the whisper-cli executable.',
            'In Settings → Resonance, select and download the model you prefer.'
          ], code: 'git clone https://github.com/ggerganov/whisper.cpp\ncd whisper.cpp\ncmake -B build -S .\ncmake --build build --config Release -j\n# example model\npowershell -Command "Invoke-WebRequest https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin -OutFile models/ggml-medium.bin"' },
          { title: 'Linux', paragraphs: [
            'Build with make; install build tools if needed; download a model.',
            'In Settings → Resonance, set the whisper.cpp repo path and the whisper-cli executable.',
            'In Settings → Resonance, select and download the model you prefer.'
          ], code: 'sudo apt update && sudo apt install -y build-essential git\ngit clone https://github.com/ggerganov/whisper.cpp\ncd whisper.cpp && make -j\n./models/download-ggml-model.sh medium' },
          { title: 'Test run', paragraphs: ['Example with Italian language:'], code: './build/bin/whisper-cli -m ./models/ggml-medium.bin -f ./samples/jfk.wav -l it' },
        ];
      case 'llm':
        return [
          { title: 'Gemini', paragraphs: ['Create an API Key in Google AI Studio and paste it in Settings. Select the model you prefer. The free version should be enough for personal use.'] },
          { title: 'Privacy', paragraphs: ['Only the text transcript is sent to the service for summarization, audio stays local.'] },
        ];
      case 'devices':
        return [
          { title: 'How to select audio devices', paragraphs: ['Use Scan to populate device lists. Select Microphone and optionally System audio depending on your OS.'] },
          { title: 'Windows (dshow)', paragraphs: ['Devices look like "audio=...". Enable Stereo Mix or similar for system audio if available.'] },
          { title: 'macOS (avfoundation)', paragraphs: ['Devices are indexed (:0, :1, …). Full system audio requires a virtual device such as BlackHole/Loopback/Soundflower.'] },
          { title: 'Linux (pulse/alsa)', paragraphs: ['Microphone often is default. Full system audio requires a loopback sink/module (PulseAudio/PipeWire).'] },
        ];
      default:
        return [];
    }
  }
}
