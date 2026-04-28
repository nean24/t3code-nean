/**
 * GeminiStreamParser tests – verifies that raw Gemini CLI stream-json lines
 * are correctly mapped to canonical ProviderRuntimeEvent objects.
 */

import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { ProviderItemId, ThreadId, TurnId } from "@t3tools/contracts";

import { parseGeminiStreamLine, parseGeminiStreamLines } from "./GeminiStreamParser.ts";

const threadId = ThreadId.make("thread-test-01");
const turnId = TurnId.make("turn-test-01");

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
    assert.deepEqual(parseGeminiStreamLine(threadId, turnId, ""), []);
    assert.deepEqual(parseGeminiStreamLine(threadId, turnId, "   "), []);
  });

  it("returns empty array for non-JSON lines", () => {
    assert.deepEqual(parseGeminiStreamLine(threadId, turnId, "not json"), []);
    assert.deepEqual(parseGeminiStreamLine(threadId, turnId, "123"), []);
  });

  it("returns empty array for invalid JSON", () => {
    assert.deepEqual(parseGeminiStreamLine(threadId, turnId, "{ invalid }"), []);
  });

  it("returns empty array for unknown event types", () => {
    assert.deepEqual(parseGeminiStreamLine(threadId, turnId, line({ type: "unknown_future_event" })), []);
  });

  describe("init", () => {
    it("returns empty array (handled by runtime)", () => {
      const events = parseGeminiStreamLine(threadId, turnId, line({ type: "init" }));
      assert.deepEqual(events, []);
    });
  });

  describe("message", () => {
    it("emits content.delta for assistant messages", () => {
      const events = parseGeminiStreamLine(
        threadId,
        turnId,
        line({ type: "message", role: "assistant", content: "Hello world" }),
      );
      assert.equal(events.length, 1);
      const ev = events[0]!;
      assert.equal(ev.type, "content.delta");
      const p = ev.payload as { streamKind: string; delta: string };
      assert.equal(p.streamKind, "assistant_text");
      assert.equal(p.delta, "Hello world");
    });

    it("returns empty array for user messages", () => {
      const events = parseGeminiStreamLine(
        threadId,
        turnId,
        line({ type: "message", role: "user", content: "Hello world" }),
      );
      assert.deepEqual(events, []);
    });

    it("returns empty array for empty text", () => {
      const events = parseGeminiStreamLine(threadId, turnId, line({ type: "message", role: "assistant", content: "" }));
      assert.deepEqual(events, []);
    });
  });

  describe("tool_use", () => {
    it("emits item.started for a bash tool call", () => {
      const events = parseGeminiStreamLine(
        threadId,
        turnId,
        line({ type: "tool_use", tool_name: "run_shell_command", parameters: { command: "ls -la" }, tool_id: "t1" }),
      );
      assert.equal(events.length, 1);
      const ev = events[0]!;
      assert.equal(ev.type, "item.started");
      const p = ev.payload as { itemType: string; status: string; detail?: string };
      assert.equal(p.itemType, "command_execution");
      assert.equal(p.status, "inProgress");
      assert.equal(p.detail, '{"command":"ls -la"}');
      assert.equal(ev.providerRefs?.providerItemId, "t1");
    });

    it("emits item.started with dynamic_tool_call for unknown tools", () => {
      const events = parseGeminiStreamLine(
        threadId,
        turnId,
        line({ type: "tool_use", tool_name: "some_custom_tool" }),
      );
      const p = events[0]!.payload as { itemType: string };
      assert.equal(p.itemType, "dynamic_tool_call");
    });
  });

  describe("tool_result", () => {
    it("emits item.completed for successful tool result", () => {
      const events = parseGeminiStreamLine(
        threadId,
        turnId,
        line({ type: "tool_result", tool_name: "run_shell_command", output: "result", status: "success" }),
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, "item.completed");
    });

    it("emits item.completed(failed) and runtime.error for failed tool result", () => {
      const events = parseGeminiStreamLine(
        threadId,
        turnId,
        line({ type: "tool_result", status: "error", tool_name: "run_shell_command", output: "command not found" }),
      );
      assert.equal(events.length, 2);
      const ev1 = events[0]!;
      assert.equal(ev1.type, "item.completed");
      assert.equal((ev1.payload as { status: string }).status, "failed");

      const ev2 = events[1]!;
      assert.equal(ev2.type, "runtime.error");
      const p = ev2.payload as { class: string; message: string };
      assert.equal(p.class, "provider_error");
      assert.equal(p.message, "command not found");
    });
  });

  describe("result", () => {
    it("emits token usage if stats are present", () => {
      const events = parseGeminiStreamLine(
        threadId,
        turnId,
        line({ type: "result", stats: { total_tokens: 100, input_tokens: 50, output_tokens: 50 } }),
      );
      assert.equal(events.length, 1);
      const ev = events[0]!;
      assert.equal(ev.type, "thread.token-usage.updated");
      const p = ev.payload as { usage: { usedTokens: number; inputTokens: number; outputTokens: number } };
      assert.equal(p.usage.usedTokens, 100);
      assert.equal(p.usage.inputTokens, 50);
      assert.equal(p.usage.outputTokens, 50);
    });

    it("returns empty array if no stats", () => {
      const events = parseGeminiStreamLine(
        threadId,
        turnId,
        line({ type: "result" }),
      );
      assert.deepEqual(events, []);
    });
  });
});

describe("parseGeminiStreamLines", () => {
  it("processes multiple lines and flattens results", () => {
    const lines = [
      JSON.stringify({ type: "message", role: "assistant", content: "Hello" }),
      JSON.stringify({ type: "message", role: "user", content: "world" }),
      JSON.stringify({ type: "result", stats: { total_tokens: 10 } }),
    ];
    const events = parseGeminiStreamLines(threadId, turnId, lines);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.type, "content.delta");
    assert.equal(events[1]!.type, "thread.token-usage.updated");
  });

  it("skips blank and non-JSON lines", () => {
    const lines = ["", "   ", "not json", JSON.stringify({ type: "message", role: "assistant", content: "world" })];
    const events = parseGeminiStreamLines(threadId, turnId, lines);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "content.delta");
  });
});
