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
      ffmpeg: 'Guida installazione FFmpeg',
      whisper: 'Guida installazione Whisper.cpp',
      llm: 'Guida configurazione LLM (Gemini)',
      devices: 'Guida dispositivi audio (FFmpeg)',
      obsidian: 'Guida configurazione Obsidian',
    }[this.topic];

    contentEl.createEl('h2', { text: title });
    const body = contentEl.createEl('div', { cls: 'resonance-help' });

    const sections = this.getContent(this.topic);
    sections.forEach(sec => {
      body.createEl('h3', { text: sec.title });
      sec.paragraphs.forEach(p => body.createEl('p', { text: p }));
      if (sec.code) {
        const pre = body.createEl('pre');
        const code = pre.createEl('code');
        code.innerText = sec.code.trim();
      }
    });
  }

  private getContent(topic: HelpTopic): { title: string; paragraphs: string[]; code?: string }[] {
    switch (topic) {
      case 'ffmpeg':
        return [
          { title: 'Cos’è FFmpeg', paragraphs: ['Utility usata per acquisire/registrare audio. È richiesta per registrare riunioni.'] },
          { title: 'macOS', paragraphs: ['Installa Homebrew, poi FFmpeg, e rileva il percorso.'], code: 'xcode-select --install\nbrew install ffmpeg' },
          { title: 'Windows', paragraphs: ['Scarica la build statica da ffmpeg.org, estrai e punta a ffmpeg.exe.'], code: 'C:/ffmpeg/bin/ffmpeg.exe' },
          { title: 'Linux', paragraphs: ['Installa dal gestore pacchetti del sistema (apt, yum, pacman).'], code: 'sudo apt install ffmpeg' },
        ];
      case 'whisper':
        return [
          { title: 'Cos’è whisper.cpp', paragraphs: ['Trascrizione locale. Usa modelli generici multilingua (.bin). Seleziona una lingua nelle impostazioni oppure lascia Automatico.'] },
          { title: 'Repo locale', paragraphs: ['Imposta la cartella root del repo whisper.cpp nelle impostazioni. Il plugin proverà a trovare automaticamente whisper-cli dentro build/bin/.'] },
          { title: 'Compilazione', paragraphs: ['Compila il progetto (make su macOS/Linux o CMake/Visual Studio su Windows).'], code: 'git clone https://github.com/ggerganov/whisper.cpp\ncd whisper.cpp\n# macOS/Linux\nmake -j\n# Windows\ncmake -B build -S .\ncmake --build build --config Release -j' },
          { title: 'Scaricare un modello', paragraphs: ['Usa la voce Modello (preset) nelle impostazioni per scaricare small/medium/large in whisper.cpp/models/. Oppure esegui lo script del repo.'], code: './models/download-ggml-model.sh medium' },
          { title: 'Esecuzione di test', paragraphs: ['Esempio con lingua italiana:'], code: './build/bin/whisper-cli -m ./models/ggml-medium.bin -f ./samples/jfk.wav -l it' },
        ];
      case 'llm':
        return [
          { title: 'Google Gemini', paragraphs: ['Crea l’API Key in Google AI Studio e incollala nelle impostazioni. Scegli il modello (flash/pro/exp).'] },
          { title: 'Privacy', paragraphs: ['Solo la trascrizione testuale viene inviata al servizio per il riassunto.'] },
        ];
      case 'devices':
        return [
          { title: 'Selezione dispositivi', paragraphs: ['Clicca Scansiona per popolare i menu di Microfono e Audio di sistema.'] },
          { title: 'Windows (dshow)', paragraphs: ['I nomi appaiono come audio=… Mic / Stereo Mix.'] },
          { title: 'macOS (avfoundation)', paragraphs: ['I dispositivi sono indicizzati. L’audio di sistema può richiedere un dispositivo virtuale (es. BlackHole).'] },
          { title: 'Linux (pulse/alsa)', paragraphs: ['Spesso il mic è default. L’audio di sistema richiede un loopback.'] },
        ];
      case 'obsidian':
        return [
          { title: 'Cartella note', paragraphs: ['Imposta la cartella del vault dove salvare le note generate. Se vuoto: root del vault.'] },
          { title: 'Ricaricare il plugin', paragraphs: ['Dopo una build, disattiva/riattiva il plugin o riavvia Obsidian.'] },
        ];
    }
  }
}
