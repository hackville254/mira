import { describe, it, expect } from "vitest";
import { enqueueMessage, dequeueMessage, hasQueued } from "../messageQueue";
import type { QueuedMessage } from "../../aiTypes";

/** Fabrique un message en attente minimal pour les tests. */
function makeMessage(text: string): QueuedMessage {
  return {
    text,
    modelId: "deepseek-chat",
    providerId: "orvyx",
    fileMentions: [],
    editorContext: null,
    mode: "agent",
  };
}

describe("messageQueue", () => {
  it("enqueueMessage place le message en file", () => {
    const q = enqueueMessage(null, makeMessage("hello"));
    expect(q.text).toBe("hello");
    expect(hasQueued(q)).toBe(true);
  });

  it("enqueueMessage écrase le message précédent (un seul en attente)", () => {
    const first = enqueueMessage(null, makeMessage("first"));
    const second = enqueueMessage(first, makeMessage("second"));
    expect(second.text).toBe("second");
  });

  it("dequeueMessage renvoie le message présent", () => {
    const q = enqueueMessage(null, makeMessage("queued"));
    expect(dequeueMessage(q)?.text).toBe("queued");
  });

  it("dequeueMessage renvoie null si la file est vide", () => {
    expect(dequeueMessage(null)).toBeNull();
  });

  it("hasQueued reflète la présence d'un message", () => {
    expect(hasQueued(null)).toBe(false);
    expect(hasQueued(makeMessage("x"))).toBe(true);
  });
});
