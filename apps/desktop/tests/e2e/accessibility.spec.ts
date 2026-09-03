import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { browser, expect, $ } from "@wdio/globals";
import axe from "axe-core";
import { prepareApplication } from "./application";
import { e2eProfile } from "./profile";

interface AccessibilityFinding {
  help: string;
  id: string;
  impact: string | null;
  nodes: Array<{
    failureSummary: string | null;
    target: string[];
  }>;
}

interface AccessibilityScan {
  incomplete: AccessibilityFinding[];
  passes: number;
  url: string;
  violations: AccessibilityFinding[];
}

type AccessibilityScanResult =
  | AccessibilityScan
  | {
      error: string;
    };

describe("BX SSH accessibility", () => {
  before(async () => {
    await prepareApplication();
    await browser.execute(axe.source);
  });

  it("meets WCAG 2.1 A and AA rules in core application states", async () => {
    const scans: Record<string, AccessibilityScan> = {};
    scans.workspace = await runAccessibilityScan();

    await $('button[aria-pressed="false"]').click();
    await $(".settings-view").waitForDisplayed();
    scans.settings = await runAccessibilityScan();
    await $(".settings-header button").click();

    const reportDirectory = path.resolve("../../artifacts/test-reports/e2e");
    mkdirSync(reportDirectory, { recursive: true });
    writeFileSync(
      path.join(reportDirectory, `accessibility-${e2eProfile.id}.json`),
      `${JSON.stringify(
        {
          profile: e2eProfile,
          standard: ["WCAG 2.1 A", "WCAG 2.1 AA"],
          scans,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    expect(
      Object.entries(scans).flatMap(([state, scan]) =>
        scan.violations.map(
          (violation) =>
            `${state}: ${violation.id} (${violation.impact ?? "unknown"}) - ${violation.help}`,
        ),
      ),
    ).toEqual([]);
  });
});

async function runAccessibilityScan(): Promise<AccessibilityScan> {
  const result = await browser.executeAsync<AccessibilityScanResult, []>(
    (done) => {
      const runtime = (
        window as typeof window & {
          axe?: {
            run(
              root: Document,
              options: unknown,
            ): Promise<{
              incomplete: AccessibilityFinding[];
              passes: unknown[];
              url: string;
              violations: AccessibilityFinding[];
            }>;
          };
        }
      ).axe;
      if (!runtime) {
        done({ error: "axe-core was not injected into the Tauri webview" });
        return;
      }

      runtime
        .run(document, {
          runOnly: {
            type: "tag",
            values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
          },
        })
        .then((result) =>
          done({
            incomplete: result.incomplete,
            passes: result.passes.length,
            url: result.url,
            violations: result.violations,
          }),
        )
        .catch((error: unknown) => done({ error: String(error) }));
    },
  );

  if ("error" in result) {
    throw new Error(result.error);
  }
  return result;
}
