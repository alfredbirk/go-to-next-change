/** Local, pull-only AgentFlow protocol. No selected text is cached or logged. */
export interface AgentFlowSelectionRequest {
    version: 1;
    nonce: string;
    sourcePID: number;
    gestureStartedAt: number;
    requestedAt: number;
    inputKind?: AgentFlowSelectionKind;
    inputDirection?: AgentFlowSelectionDirection;
    surface?: "editor" | "terminal";
    captureKind?: "startup";
}

/** Position values are one-based UTF-16 columns; both end positions are exclusive. */
export interface AgentFlowEditorLocation {
    documentKind: "file" | "git" | "untitled" | "virtual";
    filePath?: string;
    documentName?: string;
    gitRef?: string;
    diffSide?: "original" | "modified";
    documentVersion: number;
    unsaved: boolean;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
    capturedEndLine: number;
    capturedEndColumn: number;
}

export function agentFlowEditorIdentity(uri: { scheme: string; fsPath: string; path: string; query: string }):
    Pick<AgentFlowEditorLocation, "documentKind" | "filePath" | "documentName" | "gitRef"> {
    if (uri.scheme === "file") { return { documentKind: "file", filePath: uri.fsPath }; }
    if (uri.scheme === "untitled") {
        // Untitled buffers can have a proposed save path. It is not a file yet.
        return { documentKind: "untitled", documentName: uri.path.split("/").pop() };
    }
    if (uri.scheme === "git") {
        try {
            const source = JSON.parse(uri.query) as { path?: unknown; ref?: unknown } | null;
            if (typeof source?.path === "string" && source.path.startsWith("/") &&
                typeof source.ref === "string" && source.ref.length <= 1024) {
                return { documentKind: "git", filePath: source.path, gitRef: source.ref };
            }
        } catch { /* An unfamiliar Git document still has its own buffer coordinates. */ }
    }
    // Provider-specific URIs can contain account data or tokens. Do not archive them.
    return { documentKind: "virtual" };
}

export type AgentFlowSelectionKind = "mouse" | "keyboard" | "selectAll";
export type AgentFlowSelectionDirection = "left" | "right" | "up" | "down";
export type AgentFlowSelectionEventKind = AgentFlowSelectionKind | "unclassifiedExtension";

/** VS Code labels Select All as Command on some hosts. Permit that case
 * only for an entire document and a matching physical Command-A pull; Git's
 * command-driven hunk selection must never become captured context. */
export function agentFlowSelectionEventKind(kind: number | undefined, fullDocument: boolean,
    extendsSameAnchor = false): AgentFlowSelectionEventKind | undefined {
    if (kind === 2) { return "mouse"; }
    if (kind === 1) { return "keyboard"; }
    if (kind === 3 && fullDocument) { return "selectAll"; }
    // macOS word/line extension can omit the API kind. Never accept that
    // alone: the pull must also prove a fresh physical extension and direction.
    if (kind === undefined && extendsSameAnchor) { return "unclassifiedExtension"; }
    return undefined;
}

export function parseAgentFlowSelectionRequest(value: unknown, now = Date.now()): AgentFlowSelectionRequest | undefined {
    if (!value || typeof value !== "object") { return; }
    const request = value as AgentFlowSelectionRequest;
    if (request.version !== 1 || typeof request.nonce !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(request.nonce) || !Number.isSafeInteger(request.sourcePID) || request.sourcePID <= 0 ||
        !Number.isFinite(request.requestedAt) || !Number.isFinite(request.gestureStartedAt) ||
        request.requestedAt > now + 100 || now - request.requestedAt > 1000 ||
        request.gestureStartedAt > request.requestedAt || request.requestedAt - request.gestureStartedAt > 60_000 ||
        (request.inputKind !== undefined && !["mouse", "keyboard", "selectAll"].includes(request.inputKind)) ||
        (request.inputDirection !== undefined && !["left", "right", "up", "down"].includes(request.inputDirection)) ||
        (request.surface !== undefined && !["editor", "terminal"].includes(request.surface)) ||
        (request.captureKind !== undefined && request.captureKind !== "startup") ||
        (request.captureKind === "startup" && request.surface === undefined)) { return; }
    return request;
}

/** The built-in reader runs locally; its prose is not selected text. Preserve
 * the exact payload after the known header, and fail closed on other results. */
export function agentFlowTerminalSelection(parts: readonly unknown[]): string | undefined {
    if (parts.length !== 1 || typeof parts[0] !== "string") { return; }
    const prefix = "The active terminal's selection:\n";
    if (!parts[0].startsWith(prefix)) { return; }
    const selected = parts[0].slice(prefix.length);
    if (!selected.trim()) { return; }
    return selected.slice(0, 8192).replace(/[\uD800-\uDBFF]$/, "");
}

export function agentFlowSelectionIsFresh(request: AgentFlowSelectionRequest, changedAt: number, now = Date.now(),
    selectionKind: AgentFlowSelectionEventKind = "mouse", fullDocument = false,
    selectionDirection?: AgentFlowSelectionDirection): boolean {
    const expected = request.inputKind ?? "mouse"; // Original native clients stay mouse-only.
    // Word/visual-line extension may cross a logical line. Match forward or
    // backward movement without inventing a glyph/word boundary from the text.
    const alignsDirection = request.inputDirection !== undefined && selectionDirection !== undefined &&
        (["right", "down"].includes(request.inputDirection) === ["right", "down"].includes(selectionDirection));
    const matches = expected === "selectAll"
        ? fullDocument && (selectionKind === "selectAll" || selectionKind === "keyboard")
        : expected === selectionKind || (expected === "keyboard" && selectionKind === "unclassifiedExtension" &&
            alignsDirection);
    // Match this actual input kind, not an old selection or a programmatic Git command.
    // A long drag is valid: its last selection update need not occur exactly at mouse-up.
    return matches && Number.isFinite(changedAt) && changedAt >= request.gestureStartedAt - 30 &&
        changedAt <= now && now - request.requestedAt <= 1000;
}
