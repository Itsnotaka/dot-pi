export interface Diagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number;
  code?: number | string;
  source?: string;
  message: string;
}

export interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: Diagnostic[];
}

export const Severity: Record<number, string> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

export function prettyDiagnostic(file: string, d: Diagnostic): string {
  const sev = Severity[d.severity ?? 1] ?? "unknown";
  const loc = `${d.range.start.line + 1}:${d.range.start.character + 1}`;
  const src = d.source ? ` (${d.source})` : "";
  const code = d.code ? ` [${d.code}]` : "";
  return `${file}:${loc} ${sev}${code}${src}: ${d.message}`;
}
