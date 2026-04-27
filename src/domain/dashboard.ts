import type { DiagnosticsReport, DiagnosticCheck } from "./diagnostics";
import type { SessionListItem, SessionRuntimeSnapshot } from "./session";

export interface DiagnosticsGroups {
  blocking: DiagnosticCheck[];
  warnings: DiagnosticCheck[];
  healthy: DiagnosticCheck[];
}

export interface DashboardPrimaryAction {
  intent: "start" | "stop" | "blocked" | "busy";
  label: string;
  disabled: boolean;
  reason?: string;
}

export interface DashboardHealthState {
  badge: "healthy" | "warning" | "failed";
  summary: string;
  blockingCount: number;
  warningCount: number;
  groups: DiagnosticsGroups;
  report?: DiagnosticsReport;
}

export interface DashboardSnapshot {
  generatedAt: string;
  runtime: SessionRuntimeSnapshot;
  primaryAction: DashboardPrimaryAction;
  health: DashboardHealthState;
  recentSessions: SessionListItem[];
  canOpenDiagnostics: boolean;
}
