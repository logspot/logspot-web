import { describe, expect, it } from "vitest";

import { eraseCookie, setCookie } from "./cookie";

describe("eraseCookie (domain-scoped cookies)", () => {
  it("deletes a domain-scoped cookie when passed the same domain", () => {
    setCookie({
      name: "lgspt_domain_probe",
      value: "v1",
      expiresInSeconds: 3600,
      domain: "localhost",
    });
    expect(document.cookie).toContain("lgspt_domain_probe=v1");

    eraseCookie("lgspt_domain_probe", "localhost");
    expect(document.cookie).not.toContain("lgspt_domain_probe");
  });

  it("deletes a host-only cookie without a domain argument", () => {
    setCookie({
      name: "lgspt_host_probe",
      value: "v1",
      expiresInSeconds: 3600,
      domain: null,
    });
    expect(document.cookie).toContain("lgspt_host_probe=v1");

    eraseCookie("lgspt_host_probe");
    expect(document.cookie).not.toContain("lgspt_host_probe");
  });
});
