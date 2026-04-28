/**
 * GeminiStreamParser tests – verifies that raw Gemini CLI stream-json lines
 * are correctly mapped to canonical ProviderRuntimeEvent objects.
 */

import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { ThreadId, TurnId } from "@t3tools/contracts";

import { parseGeminiStreamLine, parseGeminiStreamLines } from "./GeminiStreamParser.ts";

const threadId = ThreadId.make("thread-test-01");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function line(event: object): string {
  return JSON.stringify(event);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseGeminiStreamLine", () => {
  it("returns empty array for empty input", () => {
    assert.deepEqual(parseGeminiStreamLine(threadId, ""), []);
    assert.deepEqual(parseGeminiStreamLine(threadId, "   "), []);
  });

  it("returns empty array for non-JSON lines", () => {
    assert.deepEqual(parseGeminiStreamLine(threadId, "not json"), []);
    assert.deepEqual(parseGeminiStreamLine(threadId, "123"), []);
  });

  it("returns empty array for invalid JSON", () => {
    assert.deepEqual(parseGeminiStreamLine(threadId, "{ invalid }"), []);
  });

  it("returns empty array for unknown event types", () => {
    assert.deepEqual(parseGeminiStreamLine(threadId, line({ type: "unknown_future_event" })), []);
  });

  describe("session_start", () => {
    it("emits session.state.changed with state=ready", () => {
      const events = parseGeminiStreamLine(threadId, line({ type: "session_start" }));
      assert.equal(events.length, 1);
      const ev = events[0]!;
      assert.equal(ev.type, "session.state.changed");
      assert.equal(ev.provider, "gemini");
      assert.equal(ev.threadId, threadId);
      assert.equal((ev.payload as { state: string }).state, "ready");
    });
  });

  describe("session_end", () => {
    it("emits session.exited with graceful exit", () => {
      const events = parseGeminiStreamLine(
        threadId,
        line({ type: "session_end", reason: "user requested" }),
      );
      assert.equal(events.length, 1);
      const ev = events[0]!;
      assert.equal(ev.type, "session.exited");
      const p = ev.payload as { exitKind: string; reason?: string };
      assert.equal(p.exitKind, "graceful");
      assert.equal(p.reason, "user requested");
    });

    it("emits session.exited without reason when none provided", () => {
      const events = parseGeminiStreamLine(threadId, line({ type: "session_end" }));
      const ev = events[0]!;
      assert.equal(ev.type, "session.exited");
      assert.equal((ev.payload as { reason?: string }).reason, undefined);
    });
  });

  describe("turn_start", () => {
    it("emits turn.started with turnId when provided", () => {
      const turnId = "turn-abc";
      const events = parseGeminiStreamLine(threadId, line({ type: "turn_start", turnId }));
      assert.equal(events.length, 1);
      const ev = events[0]!;
      assert.equal(ev.type, "turn.started");
      assert.equal(ev.turnId, TurnId.make(turnId));
    });

    it("emits turn.started without turnId when not provided", () => {
      const events = parseGeminiStreamLine(threadId, line({ type: "turn_start" }));
      assert.equal(events.length, 1);
      assert.equal(events[0]!.turnId, undefined);
    });
  });

  describe("turn_end", () => {
    it("emits turn.completed with state=completed", () => {
      const events = parseGeminiStreamLine(threadId, line({ type: "turn_end", turnId: "t1" }));
      assert.equal(events.length, 1);
      const ev = events[0]!;
      assert.equal(ev.type, "turn.completed");
      assert.equal((ev.payload as { state: string }).state, "completed");
    });
  });

  describe("content", () => {
    it("emits content.delta with assistant_text stream kind", () => {
      const events = parseGeminiStreamLine(
        threadId,
        line({ type: "content", text: "Hello world" }),
      );
      assert.equal(events.length, 1);
      const ev = events[0]!;
      assert.equal(ev.type, "content.delta");
      const p = ev.payload as { streamKind: string; delta: string };
      assert.equal(p.streamKind, "assistant_text");
      assert.equal(p.delta, "Hello world");
    });

    it("returns empty array for empty text", () => {
      const events = parseGeminiStreamLine(threadId, line({ type: "content", text: "" }));
      assert.deepEqual(events, []);
    });

    it("returns empty array for whitespace-only text", () => {
      const events = parseGeminiStreamLine(threadId, line({ type: "content", text: "   " }));
      assert.deepEqual(events, []);
    });
  });

  describe("tool_call", () => {
    it("emits item.started for a bash tool call", () => {
      const events = parseGeminiStreamLine(
        threadId,
        line({ type: "tool_call", tool: "bash", input: "ls -la" }),
      );
      assert.equal(events.length, 1);
      const ev = events[0]!;
      assert.equal(ev.type, "item.started");
      const p = ev.payload as { itemType: string; status: string; detail?: string };
      assert.equal(p.itemType, "command_execution");
      assert.equal(p.status, "inProgress");
      assert.equal(p.detail, "ls -la");
    });

    it("emits item.started with dynamic_tool_call for unknown tools", () => {
      const events = parseGeminiStreamLine(
        threadId,
        line({ type: "tool_call", tool: "some_custom_tool" }),
      );
      const p = events[0]!.payload as { itemType: string };
      assert.equal(p.itemType, "dynamic_tool_call");
    });
  });

  describe("tool_result", () => {
    it("emits item.completed for successful tool result", () => {
      const events = parseGeminiStreamLine(
        threadId,
        line({ type: "tool_result", tool: "bash", output: "result", status: "ok" }),
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, "item.completed");
    });

    it("emits runtime.error for failed tool result", () => {
      const events = parseGeminiStreamLine(
        threadId,
        line({ type: "tool_result", status: "error", output: "command not found" }),
      );
      assert.equal(events.length, 1);
      const ev = events[0]!;
      assert.equal(ev.type, "runtime.error");
      const p = ev.payload as { class: string; message: string };
      assert.equal(p.class, "provider_error");
      assert.equal(p.message, "command not found");
    });
  });

  describe("approval_request", () => {
    it("emits request.opened with exec_command_approval type", () => {
      const events = parseGeminiStreamLine(
        threadId,
        line({ type: "approval_request", requestId: "req-1", reason: "Execute rm -rf /tmp/test?" }),
      );
      assert.equal(events.length, 1);
      const ev = events[0]!;
      assert.equal(ev.type, "request.opened");
      const p = ev.payload as { requestType: string; detail?: string };
      assert.equal(p.requestType, "exec_command_approval");
      assert.equal(p.detail, "Execute rm -rf /tmp/test?");
    });

    it("returns empty array when requestId is missing", () => {
      const events = parseGeminiStreamLine(
        threadId,
        line({ type: "approval_request", reason: "no id" }),
      );
      assert.deepEqual(events, []);
    });
  });

  describe("approval_response", () => {
    it("emits request.resolved with accept decision", () => {
      const events = parseGeminiStreamLine(
        threadId,
        line({ type: "approval_response", requestId: "req-1", decision: "accept" }),
      );
      assert.equal(events.length, 1);
      const p = events[0]!.payload as { decision: string };
      assert.equal(p.decision, "accept");
    });

    it("emits request.resolved with decline for unknown decision", () => {
      const events = parseGeminiStreamLine(
        threadId,
        line({ type: "approval_response", requestId: "req-1", decision: "whatever" }),
      );
      const p = events[0]!.payload as { decision: string };
      assert.equal(p.decision, "decline");
    });

    it("returns empty array when requestId is missing", () => {
      const events = parseGeminiStreamLine(
        threadId,
        line({ type: "approval_response", decision: "accept" }),
      );
      assert.deepEqual(events, []);
    });
  });

  describe("error", () => {
    it("emits runtime.error with provider_error class", () => {
      const events = parseGeminiStreamLine(
        threadId,
        line({ type: "error", error: "API rate limited" }),
      );
      assert.equal(events.length, 1);
      const ev = events[0]!;
      assert.equal(ev.type, "runtime.error");
      const p = ev.payload as { class: string; message: string };
      assert.equal(p.class, "provider_error");
      assert.equal(p.message, "API rate limited");
    });

    it("falls back to text field when error field is absent", () => {
      const events = parseGeminiStreamLine(
        threadId,
        line({ type: "error", text: "Something went wrong" }),
      );
      assert.equal((events[0]!.payload as { message: string }).message, "Something went wrong");
    });

    it("returns empty array when both error and text are absent", () => {
      assert.deepEqual(parseGeminiStreamLine(threadId, line({ type: "error" })), []);
    });
  });
});

describe("parseGeminiStreamLines", () => {
  it("processes multiple lines and flattens results", () => {
    const lines = [
      JSON.stringify({ type: "turn_start", turnId: "t1" }),
      JSON.stringify({ type: "content", text: "Hello" }),
      JSON.stringify({ type: "turn_end", turnId: "t1" }),
    ];
    const events = parseGeminiStreamLines(threadId, lines);
    assert.equal(events.length, 3);
    assert.equal(events[0]!.type, "turn.started");
    assert.equal(events[1]!.type, "content.delta");
    assert.equal(events[2]!.type, "turn.completed");
  });

  it("skips blank and non-JSON lines", () => {
    const lines = ["", "   ", "not json", JSON.stringify({ type: "content", text: "world" })];
    const events = parseGeminiStreamLines(threadId, lines);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "content.delta");
  });
});
