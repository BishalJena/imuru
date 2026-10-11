import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readChartVersion } from "../src/config.js";

function chartWith(text: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "chart-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "Chart.yaml"), text);
  return dir;
}

describe("readChartVersion", () => {
  it("returns the chart version, not appVersion", () => {
    const dir = chartWith('apiVersion: v2\nname: store\nversion: 1.4.2\nappVersion: "7.1.1"\n');
    expect(readChartVersion(dir)).toBe("1.4.2");
  });

  it("accepts a quoted version", () => {
    const dir = chartWith('name: store\nversion: "0.1.0"\n');
    expect(readChartVersion(dir)).toBe("0.1.0");
  });

  it("fails loudly when the chart has no version", () => {
    expect(() => readChartVersion(chartWith("name: store\n"))).toThrow(/no version/);
  });
});
