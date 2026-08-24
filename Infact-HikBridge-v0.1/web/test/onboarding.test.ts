import { describe, expect, it } from "vitest";

import {
  defaultOnboardingDraft,
  slugifyIdentifier,
  toBootstrapRequest,
  validateOnboarding,
  validateOnboardingStep,
} from "../src/lib/onboarding";

describe("onboarding", () => {
  it("creates safe identifiers from organization names", () => {
    expect(slugifyIdentifier("  Infact Solutions (Pvt) Ltd. ")).toBe("infact-solutions-pvt-ltd");
    expect(slugifyIdentifier("---")).toBe("");
  });

  it("requires organization, branch, and attendance settings", () => {
    expect(validateOnboarding(defaultOnboardingDraft)).toMatchObject({
      organizationName: expect.any(String),
      organizationId: expect.any(String),
    });
    expect(validateOnboardingStep(2, { ...defaultOnboardingDraft, workingDays: [], endTime: "08:30" })).toMatchObject({
      workingDays: expect.any(String),
      endTime: expect.any(String),
    });
  });

  it("normalizes the submitted request", () => {
    const request = toBootstrapRequest({
      ...defaultOnboardingDraft,
      organizationName: " Infact Solutions ",
      organizationId: "infact-solutions",
      workingDays: [5, 1, 1, 3],
    });
    expect(request.organizationName).toBe("Infact Solutions");
    expect(request.workingDays).toEqual([1, 3, 5]);
  });
});

