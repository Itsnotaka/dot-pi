import { describe, expect, it } from "vitest";

import {
  prettyDiagnostic,
  Severity,
  type Diagnostic,
} from "../../../../extensions/get-diagnostics/lsp/types.ts";

describe("LSP types", () => {
  describe("Severity", () => {
    it("maps severity codes to names", () => {
      expect(Severity[1]).toBe("error");
      expect(Severity[2]).toBe("warning");
      expect(Severity[3]).toBe("info");
      expect(Severity[4]).toBe("hint");
    });
  });

  describe("prettyDiagnostic", () => {
    const baseDiag: Diagnostic = {
      range: {
        start: { line: 10, character: 5 },
        end: { line: 10, character: 15 },
      },
      message: "Variable is unused",
    };

    it("formats basic error diagnostic (default severity)", () => {
      const result = prettyDiagnostic("/src/app.ts", baseDiag);
      expect(result).toBe("/src/app.ts:11:6 error: Variable is unused");
    });

    it("uses 1-indexed line and character", () => {
      const diag: Diagnostic = {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        message: "test",
      };
      const result = prettyDiagnostic("/file.ts", diag);
      expect(result).toContain(":1:1");
    });

    it("includes severity name", () => {
      const warning: Diagnostic = { ...baseDiag, severity: 2 };
      expect(prettyDiagnostic("/f.ts", warning)).toContain("warning");
    });

    it("includes source when present", () => {
      const diag: Diagnostic = { ...baseDiag, source: "typescript" };
      const result = prettyDiagnostic("/f.ts", diag);
      expect(result).toContain("(typescript)");
    });

    it("includes code when present", () => {
      const diag: Diagnostic = { ...baseDiag, code: 6133 };
      const result = prettyDiagnostic("/f.ts", diag);
      expect(result).toContain("[6133]");
    });

    it("includes string code", () => {
      const diag: Diagnostic = { ...baseDiag, code: "no-unused-vars" };
      const result = prettyDiagnostic("/f.ts", diag);
      expect(result).toContain("[no-unused-vars]");
    });

    it("includes all parts together", () => {
      const diag: Diagnostic = {
        ...baseDiag,
        severity: 2,
        code: 6133,
        source: "ts",
      };
      const result = prettyDiagnostic("/src/index.ts", diag);
      expect(result).toBe(
        "/src/index.ts:11:6 warning [6133] (ts): Variable is unused"
      );
    });

    it("handles unknown severity", () => {
      const diag: Diagnostic = { ...baseDiag, severity: 99 };
      const result = prettyDiagnostic("/f.ts", diag);
      expect(result).toContain("unknown");
    });
  });
});
