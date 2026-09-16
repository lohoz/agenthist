import { writeFile } from "node:fs/promises";
import path from "node:path";

import { AGENTS, type Agent } from "../../src/domain/agent.js";
import { canonicalDigest } from "../../src/domain/history-identity.js";
import type { AgentSnapshot, ConversationItem, StoredSession } from "../../src/domain/history.js";
import {
  createSnapshotWorkspace,
  publishSnapshot,
} from "../../src/infrastructure/history-store.js";

export interface DesktopHistoryFixtureOptions {
  readonly stateDirectory: string;
  readonly sessionCount?: number;
  readonly longToolOutputCharacters?: number;
  readonly longConversationMessages?: number;
  readonly longSessionAgent?: Agent;
  readonly workspaceRoot?: string;
}

export interface DesktopHistoryFixtureMutation {
  readonly agent: Agent;
  readonly sessionRef?: string;
}

export interface DesktopHistoryFixture {
  readonly stateDirectory: string;
  readonly workspaceRoot: string;
  readonly snapshotIds: ReadonlyMap<Agent, string>;
  sessions(agent?: Agent): readonly StoredSession[];
  publishAll(): Promise<void>;
  publishAgent(agent: Agent): Promise<string>;
  addSession(agent: Agent): Promise<StoredSession>;
  growSession(agent: Agent, sessionRef?: string): Promise<StoredSession>;
  deleteSession(agent: Agent, sessionRef?: string): Promise<string>;
  corruptAgentHead(agent: Agent): Promise<void>;
  restoreAgentHead(agent: Agent): Promise<string>;
}

const MAX_FIXTURE_SESSIONS = 10_000;
const MAX_TOOL_OUTPUT_CHARACTERS = 64 * 1024 * 1024 - 1024;
const BASE_TIME = Date.UTC(2026, 8, 1, 0, 0, 0);

function validCount(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return selected;
}

function sessionReference(agent: Agent, index: number): string {
  return `ahsr1_${agent}_ck1_${canonicalDigest({ fixture: "desktop", agent, index })}`;
}

function timestamp(sequence: number): string {
  return new Date(BASE_TIME + sequence * 1000).toISOString();
}

function searchMarker(agent: Agent, index: number): string {
  return `ahneedle${agent}${index.toString(36)}end`;
}

function boundedLongOutput(characters: number): string {
  if (characters === 0) return "tool output completed";
  const unit = "长输出😀";
  const units = [...unit];
  return unit.repeat(Math.floor(characters / units.length)) +
    units.slice(0, characters % units.length).join("");
}

function conversation(
  agent: Agent,
  index: number,
  sequence: number,
  toolOutput: string,
  additionalMessages: number,
): ConversationItem[] {
  const marker = searchMarker(agent, index);
  return [
    {
      kind: "message",
      role: "system",
      text: `Synthetic system context for ${agent}; fixture data only.`,
      timestamp: timestamp(sequence),
    },
    {
      kind: "message",
      role: "user",
      text: `请检查 ${marker} 的 Unicode 与空格路径。`,
      timestamp: timestamp(sequence + 1),
    },
    {
      kind: "message",
      role: "assistant",
      text: `Completed synthetic task ${marker}.`,
      timestamp: timestamp(sequence + 2),
      model: "fixture-model",
      contentKinds: ["text", "tool_call"],
      portableBlocks: [
        { kind: "text", text: `Completed synthetic task ${marker}.` },
        {
          kind: "historical_tool",
          tool: {
            phase: "exchange",
            callId: `fixture-call-${agent}-${index}`,
            namespace: "fixture",
            name: "read_history",
            status: "completed",
            input: { marker, path: `C:\\合成 项目\\${agent}` },
            output: { text: toolOutput },
          },
        },
      ],
      portableNotes: ["synthetic.fixture.technical-note"],
    },
    ...Array.from({ length: additionalMessages }, (_, messageIndex): ConversationItem => ({
      kind: "message",
      role: messageIndex % 2 === 0 ? "user" : "assistant",
      text: messageIndex === 0
        ? `Long synthetic message 0 for ${marker}.\n\n\`\`\`ts\nconst fixtureClipboard = "AgentHist 🧪";\n\`\`\``
        : `Long synthetic message ${messageIndex} for ${marker}.`,
      timestamp: timestamp(sequence + 3 + messageIndex),
    })),
    {
      kind: "gap",
      label: "Synthetic native boundary",
      code: "fixture.boundary",
      timestamp: timestamp(sequence + 3 + additionalMessages),
    },
  ];
}

function makeSession(
  agent: Agent,
  index: number,
  sequence: number,
  workspaceRoot: string,
  toolOutput: string,
  additionalMessages = 0,
): StoredSession {
  const sessionRef = sessionReference(agent, index);
  const marker = searchMarker(agent, index);
  const updatedAt = timestamp(sequence + 3 + additionalMessages);
  return {
    sessionRef,
    agent,
    nativeId: `desktop-fixture-${agent}-${index}`,
    title: `${agent} 合成会话 ${index}`,
    context: path.join(workspaceRoot, `${agent} 项目 ${index % 16}`),
    model: "fixture-model",
    provider: "fixture-provider",
    createdAt: timestamp(sequence),
    updatedAt,
    nativeArchived: false,
    library: { name: "", tags: ["synthetic"], archived: false, deleted: false },
    conversation: conversation(agent, index, sequence, toolOutput, additionalMessages),
    searchText: [marker, `中文搜索 ${agent}`, "synthetic desktop fixture"],
    rawFiles: [],
    native: { fixture: "desktop", index, marker },
    scan: { fingerprint: `fixture-${canonicalDigest({ agent, index, updatedAt })}` },
  };
}

export async function createDesktopHistoryFixture(
  options: DesktopHistoryFixtureOptions,
): Promise<DesktopHistoryFixture> {
  if (!path.isAbsolute(options.stateDirectory) || options.stateDirectory.includes("\0")) {
    throw new Error("desktop fixture state directory must be absolute");
  }
  const sessionCount = validCount(options.sessionCount, 100, MAX_FIXTURE_SESSIONS, "desktop fixture session count");
  const longCharacters = validCount(
    options.longToolOutputCharacters,
    0,
    MAX_TOOL_OUTPUT_CHARACTERS,
    "desktop fixture long output size",
  );
  const longConversationMessages = validCount(
    options.longConversationMessages,
    0,
    10_000,
    "desktop fixture long conversation message count",
  );
  const longSessionAgent = options.longSessionAgent ?? "codex";
  const stateDirectory = path.normalize(options.stateDirectory);
  const workspaceRoot = path.resolve(options.workspaceRoot ?? path.join(path.dirname(stateDirectory), "工作区 roots with spaces"));
  const byAgent = new Map<Agent, StoredSession[]>(AGENTS.map((agent) => [agent, []]));
  const snapshotIds = new Map<Agent, string>();
  let nextIndex = 0;
  let sequence = 0;
  let longSessionAssigned = false;
  const longOutput = boundedLongOutput(longCharacters);
  for (let index = 0; index < sessionCount; index++) {
    const agent = AGENTS[index % AGENTS.length]!;
    const isLongSession = !longSessionAssigned && agent === longSessionAgent;
    if (isLongSession) longSessionAssigned = true;
    const selectedOutput = isLongSession ? longOutput : "tool output completed";
    byAgent.get(agent)!.push(makeSession(
      agent,
      nextIndex++,
      sequence,
      workspaceRoot,
      selectedOutput,
      isLongSession ? longConversationMessages : 0,
    ));
    sequence += 10;
  }

  const publishAgent = async (agent: Agent): Promise<string> => {
    const workspace = await createSnapshotWorkspace(stateDirectory, agent);
    const snapshot: AgentSnapshot = {
      schemaVersion: "agenthist.history-snapshot/v2",
      snapshotId: workspace.id,
      agent,
      scannedAt: timestamp(sequence++),
      sessions: byAgent.get(agent)!,
      auxiliaryFiles: [],
      warnings: [],
      scan: {
        sourceKey: `desktop-fixture-${agent}`,
        reusedSessions: 0,
        rebuiltSessions: byAgent.get(agent)!.length,
        removedSessions: 0,
      },
    };
    await publishSnapshot(stateDirectory, workspace, snapshot);
    snapshotIds.set(agent, workspace.id);
    return workspace.id;
  };

  const fixture: DesktopHistoryFixture = {
    stateDirectory,
    workspaceRoot,
    snapshotIds,
    sessions(agent) {
      return agent === undefined
        ? AGENTS.flatMap((selected) => [...byAgent.get(selected)!])
        : [...byAgent.get(agent)!];
    },
    async publishAll() {
      for (const agent of AGENTS) await publishAgent(agent);
    },
    publishAgent,
    async addSession(agent) {
      const added = makeSession(agent, nextIndex++, sequence, workspaceRoot, "new synthetic output");
      sequence += 10;
      byAgent.get(agent)!.push(added);
      await publishAgent(agent);
      return added;
    },
    async growSession(agent, requested) {
      const sessions = byAgent.get(agent)!;
      const index = requested === undefined
        ? sessions.length - 1
        : sessions.findIndex((item) => item.sessionRef === requested);
      if (index < 0 || sessions[index] === undefined) throw new Error("desktop fixture session was not found");
      const current = sessions[index]!;
      const ordinal = current.conversation.length;
      const grown: StoredSession = {
        ...current,
        updatedAt: timestamp(sequence + 3),
        conversation: [
          ...current.conversation,
          {
            kind: "message",
            role: "user",
            text: `增量增长 ${current.sessionRef} turn ${ordinal}`,
            timestamp: timestamp(sequence + 1),
          },
          {
            kind: "message",
            role: "assistant",
            text: "Incremental synthetic response.",
            timestamp: timestamp(sequence + 2),
          },
        ],
        searchText: [...current.searchText, `grown-${ordinal}`],
      };
      sequence += 10;
      sessions[index] = grown;
      await publishAgent(agent);
      return grown;
    },
    async deleteSession(agent, requested) {
      const sessions = byAgent.get(agent)!;
      const index = requested === undefined
        ? sessions.length - 1
        : sessions.findIndex((item) => item.sessionRef === requested);
      if (index < 0 || sessions[index] === undefined) throw new Error("desktop fixture session was not found");
      const [removed] = sessions.splice(index, 1);
      await publishAgent(agent);
      return removed!.sessionRef;
    },
    async corruptAgentHead(agent) {
      await writeFile(path.join(stateDirectory, "history", agent, "head.json"), "{corrupt synthetic head", "utf8");
    },
    restoreAgentHead: publishAgent,
  };
  await fixture.publishAll();
  return fixture;
}
