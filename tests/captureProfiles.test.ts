import test from "node:test";
import assert from "node:assert/strict";
import { resolveAudioFilterChain, resolveAudioProfile, CAPTURE_PROFILE_LABELS } from "../src/domain/captureProfiles";
import type { CaptureSettings } from "../src/domain/settings";

const baseCapture: CaptureSettings = {
  captureEngine: "ffmpeg",
  systemAudioMode: "off",
  ffmpegPath: "/usr/bin/ffmpeg",
  backend: "avfoundation",
  microphoneDevice: ":2",
  microphoneLabel: "Built-in Microphone",
  systemDevice: "",
  systemLabel: "",
  sampleRateHz: 48000,
  channels: 1,
  bitrateKbps: 160,
  segmentDurationSeconds: 20,
  captureProfile: "transcription",
  micGainDb: 0,
  systemGainDb: 0,
  noiseSuppression: true,
  limiter: true,
};

// ── resolveAudioProfile ──────────────────────────────────────────────────────

test("resolveAudioProfile returns transcription profile unchanged", () => {
  const profile = resolveAudioProfile({ ...baseCapture, captureProfile: "transcription" });
  assert.equal(profile.micGainDb, 6.6);
  assert.equal(profile.highpassHz, 80);
  assert.equal(profile.lowpassHz, 7000);
  assert.equal(profile.limiter, true);
  assert.equal(profile.limiterCeiling, 0.95);
  assert.equal(profile.micMixWeight, 1.65);
  assert.equal(profile.systemMixWeight, 0.75);
});

test("resolveAudioProfile returns balanced profile", () => {
  const profile = resolveAudioProfile({ ...baseCapture, captureProfile: "balanced" });
  assert.equal(profile.micGainDb, 3.0);
  assert.equal(profile.highpassHz, 80);
  assert.equal(profile.lowpassHz, 12000);
  assert.equal(profile.limiterCeiling, 0.95);
});

test("resolveAudioProfile returns natural profile with no filtering", () => {
  const profile = resolveAudioProfile({ ...baseCapture, captureProfile: "natural" });
  assert.equal(profile.micGainDb, 0);
  assert.equal(profile.highpassHz, null);
  assert.equal(profile.lowpassHz, null);
  assert.equal(profile.limiterCeiling, 0.98);
});

test("resolveAudioProfile custom profile respects user micGainDb", () => {
  const profile = resolveAudioProfile({
    ...baseCapture,
    captureProfile: "custom",
    micGainDb: 6,
    systemGainDb: -3,
    noiseSuppression: false,
    limiter: false,
  });
  assert.equal(profile.micGainDb, 6);
  assert.equal(profile.systemGainDb, -3);
  assert.equal(profile.highpassHz, null);
  assert.equal(profile.lowpassHz, null);
  assert.equal(profile.limiter, false);
});

test("resolveAudioProfile custom with noiseSuppression=true applies filters", () => {
  const profile = resolveAudioProfile({
    ...baseCapture,
    captureProfile: "custom",
    noiseSuppression: true,
  });
  assert.equal(profile.highpassHz, 80);
  assert.equal(profile.lowpassHz, 12000);
});

// ── resolveAudioFilterChain — single input ───────────────────────────────────

test("resolveAudioFilterChain transcription single-input produces -af string", () => {
  const { filterArgs, mapArgs } = resolveAudioFilterChain(
    { ...baseCapture, captureProfile: "transcription" },
    false
  );
  assert.equal(filterArgs[0], "-af");
  // Must include highpass, lowpass, volume boost, and limiter
  assert.ok(filterArgs[1].includes("highpass=f=80"), "should have highpass");
  assert.ok(filterArgs[1].includes("lowpass=f=7000"), "should have lowpass");
  assert.ok(filterArgs[1].includes("volume="), "should have volume");
  assert.ok(filterArgs[1].includes("alimiter="), "should have limiter");
  assert.deepEqual(mapArgs, ["-map", "0:a"]);
});

test("resolveAudioFilterChain natural single-input produces minimal -af string", () => {
  const { filterArgs } = resolveAudioFilterChain(
    { ...baseCapture, captureProfile: "natural" },
    false
  );
  assert.equal(filterArgs[0], "-af");
  // natural has 0 dB gain (no volume filter) and no hp/lp, only limiter
  assert.ok(!filterArgs[1].includes("highpass"), "should NOT have highpass");
  assert.ok(!filterArgs[1].includes("lowpass"), "should NOT have lowpass");
  assert.ok(!filterArgs[1].includes("volume="), "should NOT have volume filter when gain=0");
  assert.ok(filterArgs[1].includes("alimiter="), "should still have limiter");
});

test("resolveAudioFilterChain custom no-limiter no-noise produces anull or empty chain", () => {
  const { filterArgs } = resolveAudioFilterChain(
    { ...baseCapture, captureProfile: "custom", micGainDb: 0, systemGainDb: 0, noiseSuppression: false, limiter: false },
    false
  );
  // With zero gain, no filters, no limiter, should be "anull"
  assert.equal(filterArgs[0], "-af");
  assert.equal(filterArgs[1], "anull");
});

// ── resolveAudioFilterChain — dual input ─────────────────────────────────────

test("resolveAudioFilterChain transcription dual-input produces -filter_complex", () => {
  const { filterArgs, mapArgs } = resolveAudioFilterChain(
    { ...baseCapture, captureProfile: "transcription" },
    true
  );
  assert.equal(filterArgs[0], "-filter_complex");
  const fc = filterArgs[1];
  assert.ok(fc.includes("[0:a]"), "should reference first input");
  assert.ok(fc.includes("[1:a]"), "should reference second input");
  assert.ok(fc.includes("amix=inputs=2"), "should mix two inputs");
  assert.ok(fc.includes("weights='1.65 0.75'"), "should have transcription mix weights");
  assert.ok(fc.includes("[aout]"), "should produce [aout]");
  assert.deepEqual(mapArgs, ["-map", "[aout]"]);
});

test("resolveAudioFilterChain balanced dual-input has correct mix weights", () => {
  const { filterArgs } = resolveAudioFilterChain(
    { ...baseCapture, captureProfile: "balanced" },
    true
  );
  const fc = filterArgs[1];
  assert.ok(fc.includes("weights='1.2 0.9'"), "should have balanced mix weights");
});

test("resolveAudioFilterChain natural dual-input has equal mix weights and no hp/lp", () => {
  const { filterArgs } = resolveAudioFilterChain(
    { ...baseCapture, captureProfile: "natural" },
    true
  );
  const fc = filterArgs[1];
  assert.ok(fc.includes("weights='1 1'"), "should have equal weights");
  assert.ok(!fc.includes("highpass"), "should NOT have highpass in natural profile");
});

// ── filterPreview ─────────────────────────────────────────────────────────────

test("resolveAudioFilterChain filterPreview matches the effective filter string", () => {
  const { filterArgs, filterPreview } = resolveAudioFilterChain(
    { ...baseCapture, captureProfile: "balanced" },
    false
  );
  assert.equal(filterPreview, filterArgs[1]);
});

// ── CAPTURE_PROFILE_LABELS ────────────────────────────────────────────────────

test("CAPTURE_PROFILE_LABELS has labels for all four profiles", () => {
  assert.ok(CAPTURE_PROFILE_LABELS["transcription"].length > 0);
  assert.ok(CAPTURE_PROFILE_LABELS["balanced"].length > 0);
  assert.ok(CAPTURE_PROFILE_LABELS["natural"].length > 0);
  assert.ok(CAPTURE_PROFILE_LABELS["custom"].length > 0);
});
