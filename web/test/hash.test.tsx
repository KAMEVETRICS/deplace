// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useHash } from "../src/hash.js";

describe("hash routes", () => {
  it("starts each new route at the top of the page", () => {
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    location.hash = "#/";
    const { result } = renderHook(() => useHash());
    act(() => {
      location.hash = "#/board";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(result.current).toBe("#/board");
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });
});
