/** Deterministic public-contract Host for relay/browser tests; NOT a stock DSH release. */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_LIMITS,
  parseController,
  parseHandshake,
  decodeChunk,
  type Json,
  type Fence,
  type ControllerMessage,
} from "../../packages/protocol/src/index.ts";
import { hashSecret } from "../../packages/relay/src/auth.ts";
import type { SessionEventMap } from "@deepseek-ai/dsh-session";
import type { WorkspaceFileDiff } from "@deepseek-ai/dsh-workspace-changes";
import { HostFence } from "../../packages/plugin/src/control-fence.ts";
import { InteractionBridge } from "../../packages/plugin/src/interactions.ts";
// Public rc.2 durable data is different from session.prompt ContentPart DTOs.
export function userData(
  text: string,
  requestId?: string,
): SessionEventMap["user/message"] {
  return {
    id: randomUUID() as never,
    role: "user",
    content: [{ type: "text", text }],
    source: requestId
      ? { kind: "user", rpcId: requestId as never }
      : { kind: "user" },
  };
}
export function assistantData(text: string): SessionEventMap["assistant/message"] {
  return {
    turn: 0,
    step: 0,
    message: {
      id: randomUUID() as never,
      role: "assistant",
      content: [{ type: "text", text }],
      source: {
        kind: "model",
        provider: "isolated-public-contract",
        model: "deterministic",
      },
    },
    stream: [
      { type: "text-chunks", time0: 1, index: 0, dt: [], texts: [text] },
    ],
  };
}
export function toolData(text: string): SessionEventMap["tool/result"] {
  return {
    turn: 0,
    step: 0,
    message: {
      id: randomUUID() as never,
      role: "tool",
      source: { kind: "tool", callId: "fixture-call" as never },
      toolCallId: "fixture-call" as never,
      content: [{ type: "text", text }],
    },
  };
}
export const publicDiff = {
  kind: "text",
  path: "example.txt",
  display: "example.txt",
  before: true,
  after: true,
  coarse: false,
  hunks: [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ["-before", "+after"],
    },
  ],
} satisfies WorkspaceFileDiff;
const require = createRequire(
  new URL("../../packages/relay/package.json", import.meta.url),
);
const WebSocket = require("ws") as typeof import("ws").default;
export const instanceId = "10000000-0000-4000-8000-000000000012";
export class PublicHostDriver {
  failNextUpload = false;
  uploadWait?: Promise<void>;
  uncertainNextPrompt = false;
  uncertainNextReconcile = false;
  uncertainNextAnswer = false;
  staleNextStop = false;
  promptWait?: Promise<void>;
  reconcileWait?: Promise<void>;
  answerWait?: Promise<void>;
  changesWait?: Promise<void>;
  diffWait?: Promise<void>;
  holdSessionBaselines = false;
  private held: Extract<ControllerMessage, { type: "watch" }>[] = [];
  readonly commands: Extract<ControllerMessage, { type: "call" }>[] = [];
  readonly sessions = new Map<string, Json[]>();
  private socket!: import("ws").default;
  private fence?: Fence;
  private hostFence!: HostFence;
  private runtimeId = randomUUID();
  private watches = new Map<string, { topic: string; sessionId?: string }>();
  private bridge?: InteractionBridge;
  private interactions?: { push(value: unknown): void; close(): void };
  private uploads = new Map<
    string,
    {
      bytes: number;
      received: number;
      chunks: number;
      name: string;
      mediaType: string;
    }
  >();
  private accepted = new Set<string>();
  private liveRevision = 0;
  private golden!: Record<string, Json>;
  pending = [
    {
      type: "waterfall",
      eventId: "approval-a",
      agentId: "a",
      event: "approval/request",
      request: { toolName: "shell", reason: "运行本地检查？" },
    },
    {
      type: "waterfall",
      eventId: "question-a",
      agentId: "a",
      event: "user-questions/request",
      request: {
        questions: [
          {
            id: "color",
            question: "选择配色",
            options: [{ label: "中性" }, { label: "暖色" }],
          },
          {
            id: "scope",
            question: "选择范围",
            options: [{ label: "界面" }, { label: "文档" }],
            multiSelect: true,
          },
          { id: "note", question: "补充说明" },
        ],
      },
    },
  ];
  async start(
    url: string,
    deviceSecret: string,
    linkSecret: string,
  ): Promise<void> {
    this.golden = JSON.parse(
      await readFile(
        new URL(
          "../../packages/plugin/tests/fixtures/session-opening-rc2.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const event = (seq: number, type: string, data: Json): Json => ({
      type: "event",
      event: {
        type,
        seq,
        time: seq + 1,
        data,
        ...(["user/message", "assistant/message", "tool/result"].includes(type)
          ? { surfaceOp: "append" }
          : {}),
      },
    });
    this.sessions.set("a", [
      event(0, "user/message", userData("检查工作区状态") as unknown as Json),
      event(
        1,
        "tool/result",
        toolData("long-tool-line-".repeat(700)) as unknown as Json,
      ),
      event(
        2,
        "assistant/message",
        assistantData("工作区已准备好。") as unknown as Json,
      ),
      event(3, "workspace/changes", { turn: 0 }),
    ]);
    this.sessions.set("b", [
      event(
        0,
        "assistant/message",
        assistantData("开始之前，先确认任务。") as unknown as Json,
      ),
    ]);
    const identity = {
      instanceId,
      authEpoch: 1,
      enabled: true,
      relayOrigin: new URL(url).origin.replace("wss:", "https:"),
      deviceSecret,
      linkSecret,
    };
    this.hostFence = new HostFence(instanceId, this.runtimeId, () => identity);
    this.socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${deviceSecret}`,
        "X-DSH-Instance": instanceId,
      },
      rejectUnauthorized: false,
    });
    const ready = Promise.withResolvers<void>();
    this.socket.on("error", ready.reject);
    this.socket.on("message", (bytes, binary) => {
      try {
        if (binary) {
          const chunk = decodeChunk(
            new Uint8Array(bytes as Buffer),
            DEFAULT_LIMITS,
          );
          const upload = this.uploads.get(chunk.id);
          if (!upload) return;
          upload.received += chunk.data.length;
          upload.chunks++;
          if (upload.received < upload.bytes)
            this.send({
              type: "upload.credit",
              id: chunk.id,
              fence: this.fence,
              chunks: 1,
            });
          return;
        }
        const raw = JSON.parse(String(bytes));
        if (
          ["relay.ack", "relay.config", "attach", "detach", "fault"].includes(
            raw.type,
          )
        ) {
          const message = parseHandshake(String(bytes), DEFAULT_LIMITS);
          if (message.type === "relay.config") ready.resolve();
          if (message.type === "attach") {
            this.watches.clear();
            this.fence = message.fence;
            this.hostFence.install(message.fence);
            this.send({
              type: "host.attached",
              id: message.id,
              fence: message.fence,
            });
          }
          if (message.type === "detach") {
            this.interactions?.close();
            void this.bridge?.dispose();
            this.watches.clear();
            this.fence = undefined;
          }
          return;
        }
        void this.receive(parseController(String(bytes), DEFAULT_LIMITS)).catch(
          (error) => ready.reject(error),
        );
      } catch (error) {
        ready.reject(error);
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
    this.send({
      type: "host.hello",
      instanceId,
      runtimeId: this.runtimeId,
      versions: [1],
      capabilities: [],
      authEpoch: 1,
      linkVerifier: hashSecret(linkSecret),
      enabled: true,
    });
    await ready.promise;
  }
  private send(value: object): void {
    if (this.socket.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ v: 1, ...value }));
  }
  private event(id: string, value: Json): void {
    this.send({ type: "event", id, fence: this.fence, value });
  }
  private workspace(): Json {
    return {
      workspaceId: "w",
      path: "/isolated/workspace",
      title: "测试工作区",
      sessionIds: [...this.sessions.keys()],
      createdAt: "2026-10-09",
      updatedAt: "2026-10-09",
    };
  }
  private globalWorkspace(): void {
    for (const [id, watch] of this.watches)
      if (watch.topic === "workspaces")
        this.event(id, {
          kind: "dsh",
          value: { type: "upsert", workspace: this.workspace() },
        });
  }
  private async receive(message: ControllerMessage): Promise<void> {
    if (JSON.stringify(message.fence) !== JSON.stringify(this.fence)) return;
    if (message.type === "cancel") {
      this.watches.delete(message.id);
      this.send({ type: "end", id: message.id, fence: this.fence });
      return;
    }
    if (message.type === "heartbeat") return;
    if (message.type === "upload.open") {
      this.uploads.set(message.id, {
        bytes: message.bytes,
        received: 0,
        chunks: 0,
        name: message.name,
        mediaType: message.mediaType,
      });
      this.send({
        type: "upload.credit",
        id: message.id,
        fence: this.fence,
        chunks: 4,
      });
      return;
    }
    if (message.type === "upload.end") {
      const file = this.uploads.get(message.id)!;
      this.uploads.delete(message.id);
      if (this.uploadWait) await this.uploadWait;
      const failed = this.failNextUpload;
      this.failNextUpload = false;
      this.send({
        type: "result",
        id: message.id,
        fence: this.fence,
        result:
          !failed &&
          file.received === file.bytes &&
          file.chunks === message.chunks
            ? {
                ok: true,
                value: {
                  receiptId: "receipt-" + message.id,
                  name: file.name,
                  mediaType: file.mediaType,
                },
              }
            : {
                ok: false,
                error: {
                  code: "TRANSFER_CLOSED",
                  message: "TRANSFER_CLOSED",
                  retryable: false,
                },
              },
      });
      return;
    }
    if (message.type === "watch") {
      const watch = message.watch;
      this.watches.set(message.id, watch);
      if (watch.topic === "session" && this.holdSessionBaselines) {
        this.held.push(message);
        return;
      }
      if (watch.topic === "workspaces")
        this.event(message.id, {
          kind: "dsh",
          value: {
            type: "baseline",
            value: {
              items: [this.workspace()],
              archivedSessionIds: [],
              pinnedSessionIds: [],
            },
          },
        });
      if (watch.topic === "sessions")
        this.event(message.id, {
          kind: "dsh",
          value: {
            type: "baseline",
            value: {
              projections: Object.fromEntries(
                [...this.sessions].map(([id]) => [
                  id,
                  {
                    asOfSeq: 0,
                    values: {
                      title:
                        id === "a"
                          ? "核心流程"
                          : id === "b"
                            ? "准备工作"
                            : "新会话",
                    },
                  },
                ]),
              ),
            },
          },
        });
      if (watch.topic === "session") {
        const records = this.sessions.get(watch.sessionId)!;
        const selected = records.slice(-3);
        this.event(message.id, {
          kind: "dsh",
          value: {
            ...this.golden,
            header: { ...(this.golden.header as object), id: watch.sessionId },
            cursor: records.length - 1,
            records: selected,
            hasMore: records.length > selected.length,
          },
        });
        this.event(message.id, {
          kind: "stop-token",
          sessionId: watch.sessionId,
          token: "stop-" + watch.sessionId,
        });
      }
      if (watch.topic === "interactions") {
        const values: unknown[] = [
          {
            type: "ready",
            clientId: "isolated-client",
            host: { home: "/isolated" },
          },
          ...this.pending,
        ];
        let wake: (() => void) | undefined;
        let closed = false;
        this.interactions = {
          push: (value) => {
            values.push(value);
            wake?.();
          },
          close: () => {
            closed = true;
            wake?.();
          },
        };
        this.bridge = new InteractionBridge(
          this.fence!,
          this.hostFence,
          async function* (signal) {
            while (!signal.aborted && !closed) {
              if (values.length) yield values.shift();
              else
                await new Promise<void>((resolve) => {
                  wake = resolve;
                  signal.addEventListener("abort", () => resolve(), {
                    once: true,
                  });
                });
            }
          },
          (id) => {
            if (!this.sessions.has(id)) throw new Error("OUT_OF_SCOPE");
          },
          async (reply) => {
            if (this.answerWait) await this.answerWait;
            this.pending = this.pending.filter(
              (item) => item.eventId !== reply.eventId,
            );
            if (this.uncertainNextAnswer) {
              this.uncertainNextAnswer = false;
              throw new Error("RESULT_UNCERTAIN");
            }
          },
        );
        const controller = new AbortController();
        void (async () => {
          for await (const value of this.bridge!.open(controller.signal))
            this.event(message.id, value as Json);
        })().catch(() => {});
      }
      return;
    }
    if (message.type !== "call") return;
    this.commands.push(message);
    const command = message.command;
    let value: Json = null;
    try {
      if (command.op === "session.list")
        value = {
          items: [...this.sessions].map(([sessionId]) => ({ sessionId })),
        };
      if (command.op === "session.create") {
        this.sessions.set(command.sessionId, []);
        this.globalWorkspace();
        value = { sessionId: command.sessionId };
      }
      if (command.op === "session.page") {
        const older = this.sessions.get(command.sessionId)!.filter((record) => (record as any).event.seq < command.beforeSeq! && (record as any).event.seq <= command.throughSeq);
        const records = older.slice(-(command.maxMessages ?? 64));
        value = { records, hasMore: older.length > records.length };
      }
      if (command.op === "session.prompt") {
        if (command.reconcileOnly && this.reconcileWait)
          await this.reconcileWait;
        if (command.reconcileOnly) {
          if (this.uncertainNextReconcile) {
            this.uncertainNextReconcile = false;
            throw new Error("RESULT_UNCERTAIN");
          }
          if (!this.accepted.has(command.requestId))
            throw new Error("RESULT_UNCERTAIN");
        } else {
          this.accepted.add(command.requestId);
          this.append(
            command.sessionId,
            "user/message",
            userData(
              command.content
                .map((part) =>
                  part.kind === "text" ? part.text : "[附件] " + part.name,
                )
                .join("\n"),
              command.requestId,
            ) as unknown as Json,
          );
        }
        if (!command.reconcileOnly && this.promptWait) await this.promptWait;
        if (!command.reconcileOnly && this.uncertainNextPrompt) {
          this.uncertainNextPrompt = false;
          throw new Error("RESULT_UNCERTAIN");
        }
        value = { accepted: true };
      }
      if (command.op === "session.stop") {
        if (this.staleNextStop) {
          this.staleNextStop = false;
          throw new Error("STALE_ACTION");
        }
        if (command.stopToken !== "stop-" + command.sessionId)
          throw new Error("STALE_ACTION");
        value = { accepted: true };
        for (const [id, watch] of this.watches)
          if (watch.sessionId === command.sessionId)
            this.event(id, {
              kind: "stop-token",
              sessionId: command.sessionId,
              token: null,
            });
      }
      if (command.op === "interaction.answer")
        value = await this.bridge!.answer(command.deliveryId, command.answer);
      if (command.op === "file.read") throw new Error("PROTOCOL_UNSUPPORTED");
      if (command.op === "file.changes") {
        if (this.changesWait) await this.changesWait;
        value = {
          turn: 0,
          files: [
            {
              path: "example.txt",
              display: "example.txt",
              index: 0,
              added: 1,
              deleted: 1,
            },
          ],
          total: 1,
          added: 1,
          deleted: 1,
        };
      }
      if (command.op === "file.diff") {
        if (this.diffWait) await this.diffWait;
        value = publicDiff as unknown as Json;
      }
      this.send({
        type: "result",
        id: message.id,
        fence: message.fence,
        result: { ok: true, value },
      });
    } catch (error) {
      const code =
        error instanceof Error
          ? "code" in error
            ? error.code
            : error.message
          : "RESULT_UNCERTAIN";
      this.send({
        type: "result",
        id: message.id,
        fence: message.fence,
        result: {
          ok: false,
          error: { code, message: String(code), retryable: false },
        },
      });
    }
  }
  append(sessionId: string, type: string, data: Json): void {
    const records = this.sessions.get(sessionId)!;
    if (type === "assistant/message" && !(data as any).message)
      data = assistantData(
        (data as any).content?.map((part: any) => part.text ?? "").join("\n") ??
          "",
      ) as unknown as Json;
    const record: Json = {
      type: "event",
      event: {
        type,
        time: Date.now(),
        seq: records.length,
        data,
        ...(["user/message", "assistant/message", "tool/result"].includes(type)
          ? { surfaceOp: "append" }
          : {}),
      },
    };
    records.push(record);
    for (const [id, watch] of this.watches)
      if (watch.sessionId === sessionId)
        this.event(id, { kind: "dsh", value: record });
  }
  async releaseBaselines(): Promise<void> {
    this.holdSessionBaselines = false;
    for (const message of this.held.splice(0)) await this.receive(message);
  }
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId); this.globalWorkspace();
  }
  private liveIndex = 0;
  continueLive(sessionId: string, text: string): void {
    for (const [id, watch] of this.watches) if (watch.sessionId === sessionId) this.event(id, { kind: "dsh", value: { type: "assistant-stream", frame: { type: "chunk", revision: ++this.liveRevision, attemptId: "live-fixture", index: this.liveIndex++, time: 2, chunk: { type: "text-delta", index: 0, text } } } });
  }
  live(sessionId: string, text: string): void {
    this.liveIndex = 1;
    const start: Json = {
      type: "start",
      revision: ++this.liveRevision,
      attemptId: "live-fixture",
      startedAfterSeq: this.sessions.get(sessionId)!.length - 1,
      turn: 1,
      step: 0,
    };
    const chunk: Json = {
      type: "chunk",
      revision: ++this.liveRevision,
      attemptId: "live-fixture",
      index: 0,
      time: 1,
      chunk: { type: "text-delta", index: 0, text },
    };
    for (const [id, watch] of this.watches)
      if (watch.sessionId === sessionId) {
        this.event(id, {
          kind: "dsh",
          value: { type: "assistant-stream", frame: start },
        });
        this.event(id, {
          kind: "dsh",
          value: { type: "assistant-stream", frame: chunk },
        });
      }
  }
  commitLive(sessionId: string, text: string): void {
    const data = assistantData(text);
    data.turn = 1;
    this.append(sessionId, "assistant/message", data as unknown as Json);
    for (const [id, watch] of this.watches)
      if (watch.sessionId === sessionId)
        this.event(id, {
          kind: "dsh",
          value: {
            type: "assistant-stream",
            frame: {
              type: "end",
              revision: ++this.liveRevision,
              attemptId: "live-fixture",
              index: this.liveIndex,
              outcome: {
                kind: "committed",
                seq: this.sessions.get(sessionId)!.length - 1,
                eventType: "assistant/message",
              },
            },
          },
        });
  }
  cancelInteraction(eventId: string): void {
    this.pending = this.pending.filter((item) => item.eventId !== eventId);
    this.interactions?.push({ type: "cancel", eventId });
  }
  async close(): Promise<void> {
    this.interactions?.close();
    await this.bridge?.dispose();
    if (this.socket.readyState !== WebSocket.CLOSED)
      await new Promise<void>((resolve) => {
        this.socket.once("close", resolve);
        this.socket.terminate();
      });
  }
}
