import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS_V2,
  isCoreConfigured,
  isLikelyTestWhisperModelPath,
  normalizeSettingsV2,
  resolveCaptureBackend,
  resolveCaptureRuntime,
} from "../src/domain/settings";
import { getSelectedSummaryModel } from "../src/domain/providers";

test("normalizeSettingsV2 keeps defaults and clamps invalid values", () => {
  const settings = normalizeSettingsV2({
    capture: { captureEngine: "web", sampleRateHz: 1, channels: 7, bitrateKbps: 999 },
    transcription: { beamSize: 99, language: "it" },
    summary: { provider: "ollama", ollamaModel: "" },
  });

  assert.equal(settings.capture.sampleRateHz, 8_000);
  assert.equal(settings.capture.channels, 2);
  assert.equal(settings.capture.bitrateKbps, 320);
  assert.equal(settings.transcription.beamSize, 10);
  assert.equal(settings.transcription.language, "it");
  assert.equal(settings.output.vaultFolder, DEFAULT_SETTINGS_V2.output.vaultFolder);
  assert.equal(settings.capture.captureEngine, "web");
});

test("resolveCaptureBackend maps auto to OS defaults", () => {
  assert.equal(resolveCaptureBackend("auto", "darwin"), "avfoundation");
  assert.equal(resolveCaptureBackend("auto", "win32"), "dshow");
  assert.equal(resolveCaptureBackend("auto", "linux"), "pulse");
});

test("getSelectedSummaryModel follows the selected provider", () => {
  const base = DEFAULT_SETTINGS_V2.summary;
  assert.equal(getSelectedSummaryModel(base), "gemma3");
  assert.equal(getSelectedSummaryModel({ ...base, provider: "openai", openaiModel: "gpt-test" }), "gpt-test");
  assert.equal(getSelectedSummaryModel({ ...base, provider: "anthropic", anthropicModel: "claude-test" }), "claude-test");
});

test("isLikelyTestWhisperModelPath flags whisper.cpp CI models", () => {
  assert.equal(isLikelyTestWhisperModelPath("/Users/test/whisper.cpp/models/for-tests-ggml-base.bin"), true);
  assert.equal(isLikelyTestWhisperModelPath("/Users/test/whisper.cpp/models/ggml-base.bin"), false);
});

test("normalizeSettingsV2 migrates fresh installs to web capture by default", () => {
  const settings = normalizeSettingsV2({
    capture: {
      microphoneDevice: ":2",
      microphoneLabel: "Legacy mic",
    },
  });

  assert.equal(settings.capture.captureEngine, "web");
});

test("normalizeSettingsV2 preserves an explicit ffmpeg setting for compatibility", () => {
  const settings = normalizeSettingsV2({
    capture: {
      captureEngine: "ffmpeg",
      ffmpegPath: "/usr/bin/ffmpeg",
      captureProfile: "transcription",
    },
  });

  assert.equal(settings.capture.captureEngine, "ffmpeg");
});

test("normalizeSettingsV2 keeps system-device installs on web and enables the second source", () => {
  const settings = normalizeSettingsV2({
    capture: {
      systemDevice: ":1",
      systemLabel: "BlackHole 2ch",
    },
  });

  assert.equal(settings.capture.captureEngine, "web");
  assert.equal(settings.capture.systemAudioMode, "loopback");
});

test("normalizeSettingsV2 collapses the old share mode back to off", () => {
  const settings = normalizeSettingsV2({
    capture: {
      captureEngine: "web",
      systemAudioMode: "share",
    },
  });

  assert.equal(settings.capture.captureEngine, "web");
  assert.equal(settings.capture.systemAudioMode, "off");
  assert.equal(resolveCaptureRuntime(settings.capture), "web-mic");
});

test("normalizeSettingsV2 keeps explicit off mode even when stale loopback fields exist", () => {
  const settings = normalizeSettingsV2({
    capture: {
      systemAudioMode: "off",
      systemDevice: ":1",
      systemLabel: "BlackHole 2ch",
    },
  });

  assert.equal(settings.capture.captureEngine, "web");
  assert.equal(settings.capture.systemAudioMode, "off");
  assert.equal(resolveCaptureRuntime(settings.capture), "web-mic");
});

test("resolveCaptureRuntime branches across mic-only and multi-input web capture", () => {
  assert.equal(resolveCaptureRuntime({ ...DEFAULT_SETTINGS_V2.capture }), "web-mic");
  assert.equal(
    resolveCaptureRuntime({ ...DEFAULT_SETTINGS_V2.capture, captureEngine: "ffmpeg" }),
    "web-mic"
  );
  assert.equal(
    resolveCaptureRuntime({ ...DEFAULT_SETTINGS_V2.capture, systemAudioMode: "loopback" }),
    "web-multi-input"
  );
});

test("isCoreConfigured does not require ffmpeg for microphone-only web capture", () => {
  const settings = normalizeSettingsV2({
    capture: {
      captureEngine: "web",
      ffmpegPath: "",
    },
    transcription: {
      whisperCliPath: "/tmp/whisper-cli",
      modelPath: "/tmp/ggml-small.bin",
    },
    summary: {
      provider: "ollama",
      ollamaEndpoint: "http://localhost:11434",
      ollamaModel: "gemma3",
    },
  });

  assert.equal(isCoreConfigured(settings), true);
});

test("isCoreConfigured allows a second web-audio source without ffmpeg", () => {
  const settings = normalizeSettingsV2({
    capture: {
      captureEngine: "web",
      systemDevice: ":1",
      systemLabel: "BlackHole 2ch",
    },
    transcription: {
      whisperCliPath: "/tmp/whisper-cli",
      modelPath: "/tmp/ggml-small.bin",
    },
    summary: {
      provider: "ollama",
      ollamaEndpoint: "http://localhost:11434",
      ollamaModel: "gemma3",
    },
  });

  assert.equal(isCoreConfigured(settings), true);
});

test("isCoreConfigured requires an explicit second source when loopback mode is selected", () => {
  const settings = normalizeSettingsV2({
    capture: {
      captureEngine: "web",
      systemAudioMode: "loopback",
      systemDevice: "",
    },
    transcription: {
      whisperCliPath: "/tmp/whisper-cli",
      modelPath: "/tmp/ggml-small.bin",
    },
    summary: {
      provider: "ollama",
      ollamaEndpoint: "http://localhost:11434",
      ollamaModel: "gemma3",
    },
  });

  assert.equal(isCoreConfigured(settings), false);
});
