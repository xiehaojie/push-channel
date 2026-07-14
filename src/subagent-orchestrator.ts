import { spawnSubagentDirect } from "../../../src/agents/subagent-spawn.js";

export type PushChannelSubagentSpawnParams = {
  task: string;
  agentId: string;
  label?: string;
  parentSessionKey: string;
  channelId: string;
  accountId: string;
  sessionId: string;
  requesterAgentId: string;
};

type SpawnMentionedSubagentImpl = typeof spawnMentionedSubagentDirect;

let spawnMentionedSubagentImpl: SpawnMentionedSubagentImpl = spawnMentionedSubagentDirect;

export async function spawnMentionedSubagent(params: PushChannelSubagentSpawnParams) {
  return await spawnMentionedSubagentImpl(params);
}

async function spawnMentionedSubagentDirect(params: PushChannelSubagentSpawnParams) {
  const displayLabel = params.label?.trim();
  void displayLabel;
  return await spawnSubagentDirect(
    {
      task: params.task,
      agentId: params.agentId,
      mode: "run",
      cleanup: "keep",
      context: "isolated",
      expectsCompletionMessage: false,
    },
    {
      agentSessionKey: params.parentSessionKey,
      completionOwnerKey: params.parentSessionKey,
      agentChannel: params.channelId,
      agentAccountId: params.accountId,
      agentTo: params.sessionId,
      agentThreadId: params.sessionId,
      requesterAgentIdOverride: params.requesterAgentId,
    },
  );
}

export const testing = {
  setSpawnMentionedSubagentImplForTest(impl?: SpawnMentionedSubagentImpl): void {
    spawnMentionedSubagentImpl = impl ?? spawnMentionedSubagentDirect;
  },
};
