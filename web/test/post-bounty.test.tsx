// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { postMock, actMock, runMock } = vi.hoisted(() => ({ postMock: vi.fn(), actMock: vi.fn(), runMock: vi.fn() }));
vi.mock("../src/api.js", () => ({ api: { post: postMock, act: actMock } }));
vi.mock("../src/session.js", () => ({
  useSession: () => ({ account: "4jKZns1aveRVjBmGrvTp9ovsptBMktCJgoZ3zC5XTRsVrqjyuF", run: runMock, busy: false, config: { rewardToken: "EUDemo" }, setToast: vi.fn() }),
}));
const { PostBounty } = await import("../src/pages/PostBounty.js");

const KINDS = ["writing", "research", "code", "translation", "data", "design", "page-facts", "other"];
const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const fill = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const post = () => fireEvent.click(screen.getByRole("button", { name: /post/i }));
const posted = () => postMock.mock.calls[0]![0] as Record<string, unknown>;

beforeEach(() => {
  location.hash = "";
  postMock.mockResolvedValue({ prepared: { txJson: "{}", feeSponsored: true } });
  actMock.mockResolvedValue({});
  // The session signs the prepared transaction with the wallet and returns the contract's events.
  runMock.mockImplementation(async (_label: string, fn: () => Promise<unknown>) => {
    await fn();
    return { events: [{ type: "Posted", id: 7 }] };
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("posting a bounty from the web app", () => {
  it("opens empty, for any kind of task", () => {
    render(<PostBounty />);
    expect(screen.getByText(/any task/i)).toBeTruthy();
    expect(field(/title/i).value).toBe("");
    expect(field(/description/i).value).toBe("");
    expect(field(/details/i).value).toBe("");
    const kind = screen.getByLabelText(/task kind/i) as HTMLSelectElement;
    expect(kind.value).toBe("other");
    expect([...kind.options].map((o) => o.value).sort()).toEqual([...KINDS].sort());
    expect(screen.queryByLabelText(/page url/i)).toBeNull();
  });

  it("shows an example of the kind of task picked", () => {
    render(<PostBounty />);
    const titles = new Set<string>();
    for (const k of KINDS) {
      fill(/task kind/i, k);
      expect(field(/title/i).placeholder).toMatch(/^e\.g\. .+…$/);
      expect(field(/description/i).placeholder).toMatch(/.{40,}…$/);
      titles.add(field(/title/i).placeholder);
    }
    expect(titles.size).toBe(KINDS.length);
  });

  it("posts the task in the poster's words, with no details as {}, and escrows it", async () => {
    render(<PostBounty />);
    fill(/task kind/i, "writing");
    fill(/title/i, "Three taglines for Bean There");
    fill(/description/i, "Three short taglines for a coffee shop. Deliver them as a list.");
    post();
    await vi.waitFor(() => expect(location.hash).toBe("#/b/7"));
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(posted()).toMatchObject({
      title: "Three taglines for Bean There",
      description: "Three short taglines for a coffee shop. Deliver them as a list.",
      taskKind: "writing",
      kind: "Exclusive",
      reward: "1",
    });
    expect(posted().input).toEqual({});
    expect(typeof posted().deadline).toBe("number");
    expect(actMock).toHaveBeenCalledWith("7", "fund-transfer");
  });

  it("sends JSON details as written", async () => {
    render(<PostBounty />);
    fill(/title/i, "Name ideas for a cycling podcast");
    fill(/details/i, '{"words": 200}');
    post();
    await vi.waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(posted().taskKind).toBe("other");
    expect(posted().input).toEqual({ words: 200 });
  });

  it("asks a page-facts poster for the page and posts its URL as the input", async () => {
    render(<PostBounty />);
    fill(/task kind/i, "page-facts");
    expect(screen.queryByLabelText(/details/i)).toBeNull();
    fill(/page url/i, " https://example.org ");
    fill(/title/i, "Page facts for example.org");
    post();
    await vi.waitFor(() => expect(postMock).toHaveBeenCalled());
    expect(posted().taskKind).toBe("page-facts");
    expect(posted().input).toEqual({ url: "https://example.org" });
  });

  it.each([
    { what: "a bounty without a title", kind: "writing", title: "   ", url: "", details: "", bad: /title/i, says: /title/i },
    { what: "a page-facts bounty without a full URL", kind: "page-facts", title: "Facts", url: "example.org", details: "", bad: /page url/i, says: /https:\/\//i },
    { what: "details that aren't JSON", kind: "data", title: "Clean a list", url: "", details: "{words: 200}", bad: /details/i, says: /JSON object/i },
    { what: "details that aren't a JSON object", kind: "data", title: "Clean a list", url: "", details: "[1, 2]", bad: /details/i, says: /JSON object/i },
  ])("says what to fix and posts nothing for $what", async ({ kind, title, url, details, bad, says }) => {
    render(<PostBounty />);
    fill(/task kind/i, kind);
    fill(/title/i, title);
    if (url) fill(/page url/i, url);
    if (details) fill(/details/i, details);
    post();
    expect((await screen.findByRole("alert")).textContent).toMatch(says);
    expect(field(bad).getAttribute("aria-invalid")).toBe("true");
    expect(runMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });
});
