import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS_V2,
  isLikelyTestWhisperModelPath,
  normalizeSettingsV2,
  resolveCaptureBackend,
} from "../src/domain/settings";
import { getSelectedSummaryModel } from "../src/domain/providers";

test("normalizeSettingsV2 keeps defaults and clamps invalid values", () => {
  const settings = normalizeSettingsV2({
    capture: { sampleRateHz: 1, channels: 7, bitrateKbps: 999 },
    transcription: { beamSize: 99, language: "it" },
    summary: { provider: "ollama", ollamaModel: "" },
  });

  assert.equal(settings.capture.sampleRateHz, 8_000);
  assert.equal(settings.capture.channels, 2);
  assert.equal(settings.capture.bitrateKbps, 320);
  assert.equal(settings.transcription.beamSize, 10);
  assert.equal(settings.transcription.language, "it");
  assert.equal(settings.output.vaultFolder, DEFAULT_SETTINGS_V2.output.vaultFolder);
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
