import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  hasAdditionalCaptureSources,
  isCoreConfigured,
  isLikelyTestWhisperModelPath,
  normalizeSettings,
} from "../src/domain/settings";
import { getSelectedSummaryModel } from "../src/domain/providers";

test("normalizeSettings keeps defaults and clamps invalid values", () => {
  const settings = normalizeSettings({
    capture: { segmentDurationSeconds: 1 },
    transcription: { beamSize: 99, language: "it" },
    summary: { provider: "ollama", ollamaModel: "" },
  });

  assert.equal(settings.capture.segmentDurationSeconds, 5);
  assert.equal(settings.transcription.beamSize, 10);
  assert.equal(settings.transcription.language, "it");
  assert.equal(settings.output.vaultFolder, DEFAULT_SETTINGS.output.vaultFolder);
  assert.deepEqual(settings.capture.additionalSources, []);
});

test("normalizeSettings ignores deprecated capture fields and resets to the new schema", () => {
  const settings = normalizeSettings({
    capture: {
      microphoneDevice: "mic-1",
      microphoneLabel: "USB Microphone",
      systemDevice: "loopback-1",
      systemLabel: "BlackHole 2ch",
    },
  });

  assert.deepEqual(settings.capture.microphone, {
    deviceId: "",
    label: "",
  });
  assert.deepEqual(settings.capture.additionalSources, []);
});

test("normalizeSettings deduplicates additional sources and removes the microphone from the extras list", () => {
  const settings = normalizeSettings({
    capture: {
      microphone: { deviceId: "mic-1", label: "USB Microphone" },
      additionalSources: [
        { deviceId: "loopback-1", label: "BlackHole 2ch" },
        { deviceId: "loopback-1", label: "BlackHole 2ch" },
        { deviceId: "mic-1", label: "USB Microphone" },
      ],
    },
  });

  assert.deepEqual(settings.capture.additionalSources, [
    {
      deviceId: "loopback-1",
      label: "BlackHole 2ch",
    },
  ]);
});

test("getSelectedSummaryModel follows the selected provider", () => {
  const base = DEFAULT_SETTINGS.summary;
  assert.equal(getSelectedSummaryModel(base), "gemma3");
  assert.equal(getSelectedSummaryModel({ ...base, provider: "openai", openaiModel: "gpt-test" }), "gpt-test");
  assert.equal(getSelectedSummaryModel({ ...base, provider: "anthropic", anthropicModel: "claude-test" }), "claude-test");
});

test("isLikelyTestWhisperModelPath flags whisper.cpp CI models", () => {
  assert.equal(isLikelyTestWhisperModelPath("/Users/test/whisper.cpp/models/for-tests-ggml-base.bin"), true);
  assert.equal(isLikelyTestWhisperModelPath("/Users/test/whisper.cpp/models/ggml-base.bin"), false);
});

test("hasAdditionalCaptureSources reports whether extra inputs are configured", () => {
  assert.equal(hasAdditionalCaptureSources(DEFAULT_SETTINGS.capture), false);
  assert.equal(
    hasAdditionalCaptureSources({
      ...DEFAULT_SETTINGS.capture,
      additionalSources: [{ deviceId: "loopback-1", label: "BlackHole 2ch" }],
    }),
    true
  );
});

test("isCoreConfigured does not depend on extra sources, only on transcription and summary readiness", () => {
  const settings = normalizeSettings({
    capture: {
      microphone: { deviceId: "mic-1", label: "USB Microphone" },
      additionalSources: [{ deviceId: "loopback-1", label: "BlackHole 2ch" }],
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
