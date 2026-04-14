import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  resolveCommandForLogs,
  renderTemplate,
  runChildProcess,
  ensurePaperclipSkillSymlink,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
  removeMaintainerOnlySkillSymlinks,
} from "@paperclipai/adapter-utils/server-utils";
import { resolveDevinSkillsHome } from "./skills.js";

const DEFAULT_COMMAND = "devin";
const DEFAULT_PERMISSION_MODE = "dangerous";
const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function ensureDevinSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  config: Record<string, unknown>,
  skillsEntries: Array<{ key: string; runtimeName: string; source: string }>,
  desiredSkillNames?: string[],
  workspaceCwd?: string,
): Promise<void> {
  const desiredSet = new Set(desiredSkillNames ?? skillsEntries.map((entry) => entry.key));
  const selectedEntries = skillsEntries.filter((entry) => desiredSet.has(entry.key));
  if (selectedEntries.length === 0) return;

  const skillsHome = resolveDevinSkillsHome(config, workspaceCwd);
  try {
    await fs.mkdir(skillsHome, { recursive: true });
  } catch (err) {
    await onLog(
      "stderr",
      `[paperclip] Failed to prepare Devin skills directory ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return;
  }
  const removedSkills = await removeMaintainerOnlySkillSymlinks(
    skillsHome,
    selectedEntries.map((entry) => entry.runtimeName),
  );
  for (const skillName of removedSkills) {
    await onLog(
      "stderr",
      `[paperclip] Removed maintainer-only Devin skill "${skillName}" from ${skillsHome}\n`,
    );
  }

  for (const entry of selectedEntries) {
    const target = path.join(skillsHome, entry.runtimeName);
    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, target);
      if (result === "skipped") continue;
      await onLog(
        "stderr",
        `[paperclip] ${result === "repaired" ? "Repaired" : "Injected"} Devin skill "${entry.key}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Failed to inject Devin skill "${entry.key}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

type DevinSession = {
  id: string;
  last_activity_at: number;
  working_directory: string;
};

async function findLatestDevinSession(
  command: string,
  cwd: string,
  env: Record<string, string>,
): Promise<string | null> {
  try {
    const proc = await runChildProcess("devin-list", command, ["list", "--format", "json"], {
      cwd,
      env,
      timeoutSec: 10,
      graceSec: 5,
      onLog: async () => {},
    });
    if ((proc.exitCode ?? 0) !== 0) return null;
    const raw = proc.stdout.trim();
    if (!raw) return null;
    const entries = JSON.parse(raw) as DevinSession[];
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const resolvedCwd = path.resolve(cwd);
    const matching = entries
      .filter((e) => path.resolve(e.working_directory) === resolvedCwd)
      .sort((a, b) => b.last_activity_at - a.last_activity_at);
    return matching[0]?.id ?? null;
  } catch {
    return null;
  }
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const command = asString(config.command, DEFAULT_COMMAND);
  const model = asString(config.model, "").trim();
  const permissionMode = asString(config.permissionMode, DEFAULT_PERMISSION_MODE).trim();
  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = asStringArray(config.extraArgs);
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const agentHome = asString(workspaceContext.agentHome, "") || null;
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const devinSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredDevinSkillNames = resolvePaperclipDesiredSkillNames(config, devinSkillEntries);
  await ensureDevinSkillsInjected(onLog, config, devinSkillEntries, desiredDevinSkillNames, cwd);

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PYTHONUNBUFFERED = "1";
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (effectiveWorkspaceCwd) env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  if (workspaceSource) env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  if (workspaceId) env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  if (workspaceRepoUrl) env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  if (workspaceRepoRef) env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  if (agentHome) env.AGENT_HOME = agentHome;
  if (workspaceHints.length > 0) env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  await ensureCommandResolvable(command, cwd, runtimeEnv);
  const resolvedCommand = await resolveCommandForLogs(command, cwd, runtimeEnv);
  const loggedEnv = buildInvocationEnvForLogs(env, {
    runtimeEnv,
    includeRuntimeKeys: ["HOME"],
    resolvedCommand,
  });

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const canResumeSession = runtimeSessionId.length > 0;
  const sessionId = canResumeSession ? runtimeSessionId : null;

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };

  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const renderedBootstrapPrompt =
    !canResumeSession && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";

  let instructionsPreamble = "";
  if (instructionsFilePath) {
    try {
      const instructionsContent = await fs.readFile(instructionsFilePath, "utf-8");
      instructionsPreamble = instructionsContent.trim();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }

  const prompt = joinPromptSections([
    instructionsPreamble,
    renderedBootstrapPrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsPreambleChars: instructionsPreamble.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const promptFile = path.join(os.tmpdir(), `devin-prompt-${runId}.txt`);
  await fs.writeFile(promptFile, prompt, "utf-8");

  const buildArgs = (resumeSessionId: string | null): string[] => {
    const args: string[] = [];
    if (resumeSessionId) args.push("-r", resumeSessionId);
    args.push("--prompt-file", promptFile);
    args.push("-p");
    if (model) args.push("--model", model);
    if (permissionMode) args.push("--permission-mode", permissionMode);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const args = buildArgs(sessionId);
  const commandNotes: string[] = [];
  if (instructionsFilePath) {
    commandNotes.push(`Loaded agent instructions from ${instructionsFilePath} (prepended to prompt)`);
  }

  if (onMeta) {
    await onMeta({
      adapterType: "devin_local",
      command: resolvedCommand,
      cwd,
      commandArgs: args,
      commandNotes,
      env: loggedEnv,
      prompt,
      promptMetrics,
      context,
    });
  }

  try {
    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog,
    });

    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
      };
    }

    let resolvedSessionId: string | null = sessionId;
    if (!resolvedSessionId && (proc.exitCode ?? 0) === 0) {
      resolvedSessionId = await findLatestDevinSession(command, cwd, runtimeEnv);
    }
    const resolvedSessionParams = resolvedSessionId
      ? ({
          sessionId: resolvedSessionId,
          cwd,
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
        } as Record<string, unknown>)
      : null;

    const stderrLine = firstNonEmptyLine(proc.stderr);
    const exitCode = proc.exitCode ?? 0;

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage:
        exitCode === 0
          ? null
          : stderrLine
            ? `devin exited with code ${exitCode}: ${stderrLine}`
            : `devin exited with code ${exitCode}`,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
      summary: lastNonEmptyLine(proc.stdout),
    };
  } finally {
    fs.unlink(promptFile).catch(() => {});
  }
}
