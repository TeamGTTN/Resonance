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
      llm: 'LLM setup guide',
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
            'Alternatively, if you use Chocolatey.',
          ], code: 'choco install ffmpeg' },
          { title: 'Linux', paragraphs: [
            'Install FFmpeg from your package manager.',
          ], code: 'sudo apt install ffmpeg' },
        ];
      case 'whisper':
        return [
          { title: 'What is whisper.cpp', paragraphs: [
            'whisper.cpp is a local speech‑to‑text engine; Resonance runs it on your machine.',
            'You must set the repo path and choose/download a model (.bin).'
          ]},
          { title: 'macOS', paragraphs: [
            'Clone the repo and build with make.',
            'In Settings → Resonance, set the whisper.cpp repo path and the whisper-cli executable.',
            'In Settings → Resonance, select and download the model you prefer.'
          ], code: 'git clone https://github.com/ggerganov/whisper.cpp\ncd whisper.cpp\nmake -j' },
          { title: 'Windows', paragraphs: [
            'Clone the repo and build with CMake, you may need to install Visual Studio with c++ tools and use the developer command prompt.',
            'In Settings → Resonance, set the whisper.cpp repo path and the whisper-cli executable.',
            'In Settings → Resonance, select and download the model you prefer.'
          ], code: 'git clone https://github.com/ggerganov/whisper.cpp\ncd whisper.cpp\ncmake -B build -S .\ncmake --build build --config Release -j"' },
          { title: 'Linux', paragraphs: [
            'Clone the repo and build with make.',
            'In Settings → Resonance, set the whisper.cpp repo path and the whisper-cli executable.',
            'In Settings → Resonance, select and download the model you prefer.'
          ], code: 'sudo apt update && sudo apt install -y build-essential git\ngit clone https://github.com/ggerganov/whisper.cpp\ncd whisper.cpp && make -j' },
          { title: 'Test run', paragraphs: ['Example with Italian language:'], code: './build/bin/whisper-cli -m ./models/ggml-medium.bin -f ./samples/jfk.wav -l it' },
        ];
      case 'llm':
        return [
          { title: 'API Key', paragraphs: ['Create an API Key (Google AI Studio or other) and paste it in Settings. Select the model you prefer.'] },
          { title: 'Privacy', paragraphs: ['Only the text transcript is sent to the service for summarization, audio stays local.'] },
        ];
      case 'devices':
        return [
          { title: 'How to select audio devices', paragraphs: ['Use Scan to populate device lists. Select Microphone and optionally System audio depending on your OS.'] },
          { title: 'Windows (dshow)', paragraphs: ['For full system audio enable Stereo Mix or use a virtual device such as Voicemeeter.'] },
          { title: 'macOS (avfoundation)', paragraphs: ['For full system audio use BlackHole or Loopback.'] },
          { title: 'Linux (pulse/alsa)', paragraphs: ['For full system audio use Loopback.'] },
        ];
      default:
        return [];
    }
  }
}
