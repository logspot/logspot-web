import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logspot } from "./index";
import { __resetInMemoryAnonymousIdForTests } from "./anonymous-id";
import { tagPaymentLinkHref } from "./payment-links";

const ANON = "11111111-2222-4333-8444-555555555555";

describe("tagPaymentLinkHref", () => {
  it("adds client_reference_id to a Stripe Payment Link", () => {
    expect(
      tagPaymentLinkHref("https://buy.stripe.com/test_abc123?locale=fr", ANON)
    ).toBe(
      `https://buy.stripe.com/test_abc123?locale=fr&client_reference_id=${ANON}`
    );
  });

  it("never overwrites an existing client_reference_id", () => {
    expect(
      tagPaymentLinkHref(
        "https://buy.stripe.com/abc?client_reference_id=mine",
        ANON
      )
    ).toBeNull();
  });

  it("leaves other hosts alone, including look-alikes", () => {
    for (const href of [
      "https://example.com/buy",
      "https://checkout.stripe.com/c/pay/cs_test_1",
      "https://buy.stripe.com.evil.io/abc",
      "not a url",
    ]) {
      expect(tagPaymentLinkHref(href, ANON), href).toBeNull();
    }
  });
});

describe("payment link tagging in the SDK", () => {
  const addLink = (href: string) => {
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.textContent = "Buy";
    document.body.appendChild(anchor);
    return anchor;
  };

  const press = (anchor: HTMLAnchorElement) => {
    // jsdom does not implement navigation; keep the click from attempting it.
    anchor.addEventListener("click", (event) => event.preventDefault(), {
      once: true,
    });
    anchor.click();
  };

  const init = (config: Record<string, unknown> = {}) =>
    logspot.init({
      publicKey: "pk_test_123",
      enableAutoPageviews: false,
      externalApiUrl: "https://api.example.com/i",
      ...config,
    });

  beforeEach(() => {
    window.localStorage.clear();
    __resetInMemoryAnonymousIdForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 200 }))
    );
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("tags a pressed Payment Link with the anonymous id", async () => {
    await init();
    const anchor = addLink("https://buy.stripe.com/abc");
    press(anchor);
    expect(new URL(anchor.href).searchParams.get("client_reference_id")).toBe(
      logspot.getAnonymousId()
    );
  });

  it("re-tags with the new id after reset(), but keeps a customer's id", async () => {
    await init();
    const ours = addLink("https://buy.stripe.com/abc");
    const theirs = addLink(
      "https://buy.stripe.com/abc?client_reference_id=mine"
    );
    press(ours);
    const before = logspot.getAnonymousId();
    logspot.reset();
    press(ours);
    press(theirs);
    const after = new URL(ours.href).searchParams.get("client_reference_id");
    expect(after).toBe(logspot.getAnonymousId());
    expect(after).not.toBe(before);
    expect(new URL(theirs.href).searchParams.get("client_reference_id")).toBe(
      "mine"
    );
  });

  it("re-tags from a new href the app set after tagging", async () => {
    await init();
    const link = addLink("https://buy.stripe.com/abc");
    press(link);
    link.href = "https://buy.stripe.com/xyz";
    press(link);
    expect(link.href).toBe(
      `https://buy.stripe.com/xyz?client_reference_id=${logspot.getAnonymousId()}`
    );
  });

  it("does not tag when tagPaymentLinks is false", async () => {
    await init({ tagPaymentLinks: false });
    const anchor = addLink("https://buy.stripe.com/abc");
    press(anchor);
    expect(anchor.href).toBe("https://buy.stripe.com/abc");
  });

  it("does not tag before express consent is granted", async () => {
    await init({ consentBehavior: "express" });
    const anchor = addLink("https://buy.stripe.com/abc");
    press(anchor);
    expect(anchor.href).toBe("https://buy.stripe.com/abc");

    await logspot.setConsent({ analytics: true });
    press(anchor);
    expect(new URL(anchor.href).searchParams.get("client_reference_id")).toBe(
      logspot.getAnonymousId()
    );
  });
});
