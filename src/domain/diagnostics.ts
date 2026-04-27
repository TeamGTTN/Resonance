import type { SummaryProviderId } from "./providers";

export type DiagnosticSeverity = "ok" | "warning" | "error";

export interface DiagnosticCheck {
  id: string;
  label: string;
  severity: DiagnosticSeverity;
  detail: string;
  remediation?: string;
}

export interface DiagnosticsReport {
  checkedAt: string;
  provider: SummaryProviderId;
  backend: "avfoundation" | "dshow" | "pulse" | "alsa";
  checks: DiagnosticCheck[];
  blockingIssueIds: string[];
  warningIds: string[];
  isHealthy: boolean;
  summary: string;
}
