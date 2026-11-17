import * as assert from "assert";
import { agentFlowEditorIdentity, agentFlowSelectionEventKind, agentFlowSelectionIsFresh, agentFlowTerminalSelection, parseAgentFlowSelectionRequest } from "../../agentFlowSelectionProtocol";

suite("AgentFlow selection protocol", () => {
    const request = { version: 1 as const, nonce: "12345678-1234-1234-1234-123456789012", sourcePID: 42,
        gestureStartedAt: 9000, requestedAt: 10_000 };
    test("editor identity distinguishes working files, Git snapshots and unsaved buffers", () => {
        const path = "/workspace/Name & Code.swift";
        const uri = { scheme: "file", path, fsPath: path, query: "" };
        assert.deepStrictEqual(agentFlowEditorIdentity(uri), { documentKind: "file", filePath: path });
        assert.deepStrictEqual(agentFlowEditorIdentity({ ...uri, scheme: "git", query: JSON.stringify({ path, ref: "~" }) }),
            { documentKind: "git", filePath: path, gitRef: "~" });
        assert.deepStrictEqual(agentFlowEditorIdentity({ ...uri, scheme: "untitled" }),
            { documentKind: "untitled", documentName: "Name & Code.swift" });
        assert.deepStrictEqual(agentFlowEditorIdentity({ ...uri, scheme: "custom", query: "private data" }), { documentKind: "virtual" });
    });
    test("only a bounded versioned recent request is accepted", () => {
        assert.deepStrictEqual(parseAgentFlowSelectionRequest(request, 10_050), request);
        for (const update of [{ version: 2 }, { nonce: "bad" }, { sourcePID: -1 },
            { gestureStartedAt: 10_001 }, { requestedAt: 20_000 }, { requestedAt: 1 },
            { gestureStartedAt: NaN }, { sourcePID: 1.5 }]) {
            assert.strictEqual(parseAgentFlowSelectionRequest({ ...request, ...update }, 10_050), undefined);
        }
    });
    test("fresh selection belongs to this gesture, including a long drag", () => {
        assert.ok(agentFlowSelectionIsFresh(request, 9001, 10_050));
        assert.ok(!agentFlowSelectionIsFresh(request, 8500, 10_050));
        assert.ok(!agentFlowSelectionIsFresh(request, 11_000, 10_050));
        assert.ok(!agentFlowSelectionIsFresh(request, 9500, 12_000));
    });
    test("terminal requests are explicit and cannot become editor requests", () => {
        assert.ok(parseAgentFlowSelectionRequest({ ...request, surface: "terminal" }, 10_050));
        assert.ok(parseAgentFlowSelectionRequest({ ...request, surface: "editor" }, 10_050));
        assert.strictEqual(parseAgentFlowSelectionRequest({ ...request, surface: "other" }, 10_050), undefined);
    });
    test("startup snapshots name their pane and never relax live gesture freshness", () => {
        assert.ok(parseAgentFlowSelectionRequest({ ...request, surface: "editor", captureKind: "startup" }, 10_050));
        assert.ok(parseAgentFlowSelectionRequest({ ...request, surface: "terminal", captureKind: "startup" }, 10_050));
        assert.strictEqual(parseAgentFlowSelectionRequest({ ...request, captureKind: "startup" }, 10_050), undefined);
        assert.strictEqual(parseAgentFlowSelectionRequest({ ...request, surface: "editor", captureKind: "other" }, 10_050), undefined);
        assert.ok(!agentFlowSelectionIsFresh(request, 8500, 10_050));
    });
    test("terminal reader returns only exact selected text, preserving whitespace", () => {
        assert.strictEqual(agentFlowTerminalSelection(["The active terminal's selection:\n  selected\n"]), "  selected\n");
        for (const parts of [[], [undefined], ["No text is currently selected in the active terminal."],
            ["The active terminal's selection:\n \n"], ["editor", "terminal"]]) {
            assert.strictEqual(agentFlowTerminalSelection(parts), undefined);
        }
        assert.strictEqual(agentFlowTerminalSelection(["The active terminal's selection:\n" + "x".repeat(8191) + "😀"]), "x".repeat(8191));
    });
    test("keyboard and mouse gestures never borrow each other's range", () => {
        const keyboard = { ...request, inputKind: "keyboard" as const };
        assert.ok(agentFlowSelectionIsFresh(keyboard, 9500, 10_050, "keyboard"));
        assert.ok(!agentFlowSelectionIsFresh(keyboard, 9500, 10_050, "mouse"));
        assert.ok(!agentFlowSelectionIsFresh(request, 9500, 10_050, "keyboard"));
        assert.strictEqual(parseAgentFlowSelectionRequest({ ...request, inputKind: "command" }, 10_050), undefined);
    });
    test("Select All commands require the whole document and a matching physical pull", () => {
        assert.strictEqual(agentFlowSelectionEventKind(2, false), "mouse");
        assert.strictEqual(agentFlowSelectionEventKind(1, false), "keyboard");
        assert.strictEqual(agentFlowSelectionEventKind(3, false), undefined);
        assert.strictEqual(agentFlowSelectionEventKind(undefined, true), undefined);
        assert.strictEqual(agentFlowSelectionEventKind(3, true), "selectAll");
        const all = { ...request, inputKind: "selectAll" as const };
        assert.ok(agentFlowSelectionIsFresh(all, 9500, 10_050, "selectAll", true));
        assert.ok(agentFlowSelectionIsFresh(all, 9500, 10_050, "keyboard", true));
        assert.ok(!agentFlowSelectionIsFresh(all, 9500, 10_050, "keyboard", false));
        assert.ok(!agentFlowSelectionIsFresh(request, 9500, 10_050, "selectAll", true));
        assert.ok(!agentFlowSelectionIsFresh(keyboardRequest(), 9500, 10_050, "selectAll", true));
    });
    function keyboardRequest() { return { ...request, inputKind: "keyboard" as const }; }
    test("unclassified word/line extension requires a physical kind, unchanged anchor and matching direction", () => {
        assert.strictEqual(agentFlowSelectionEventKind(undefined, false, false), undefined);
        assert.strictEqual(agentFlowSelectionEventKind(undefined, false, true), "unclassifiedExtension");
        assert.strictEqual(agentFlowSelectionEventKind(3, false, true), undefined);
        assert.ok(!agentFlowSelectionIsFresh(request, 9500, 10_050, "unclassifiedExtension", false, "right"));
        assert.ok(!agentFlowSelectionIsFresh(keyboardRequest(), 9500, 10_050, "unclassifiedExtension", false, "right"));
        const physical = { ...keyboardRequest(), inputDirection: "right" as const };
        assert.ok(agentFlowSelectionIsFresh(physical, 9500, 10_050, "unclassifiedExtension", false, "right"));
        assert.ok(agentFlowSelectionIsFresh(physical, 9500, 10_050, "unclassifiedExtension", false, "down"));
        assert.ok(!agentFlowSelectionIsFresh(physical, 9500, 10_050, "unclassifiedExtension", false, "left"));
        assert.ok(!agentFlowSelectionIsFresh(physical, 8500, 10_050, "unclassifiedExtension", false, "right"));
    });
});
