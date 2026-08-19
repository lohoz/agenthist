interface OpenCodeTaskIdentity {
  readonly sessionId: string;
}

export interface OpenCodeTaskDescriptor {
  readonly kind:
    | "foreground_completed"
    | "foreground_resumed"
    | "background_started"
    | "background_updated";
  readonly childId: string;
  readonly description: string;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasOnlyFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const fields = new Set(allowed);
  return Object.keys(value).every((name) => fields.has(name));
}

function taskInput(value: unknown): Record<string, unknown> | undefined {
  const input = objectValue(value);
  if (
    input === undefined ||
    !hasOnlyFields(input, ["description", "prompt", "subagent_type", "task_id", "command", "background"]) ||
    typeof input.description !== "string" || typeof input.prompt !== "string" ||
    typeof input.subagent_type !== "string" || input.subagent_type === "" ||
    (input.task_id !== undefined && typeof input.task_id !== "string") ||
    (input.command !== undefined && typeof input.command !== "string") ||
    (input.background !== undefined && typeof input.background !== "boolean")
  ) return undefined;
  return input;
}

function taskModel(value: unknown): Record<string, unknown> | undefined {
  const model = objectValue(value);
  return model !== undefined && hasOnlyFields(model, ["providerID", "modelID"]) &&
    typeof model.providerID === "string" && model.providerID !== "" &&
    typeof model.modelID === "string" && model.modelID !== ""
    ? model
    : undefined;
}

function backgroundRunningOutput(childId: string, updated: boolean): string {
  const detail = updated
    ? [
        "Additional context sent to the running background task.",
        "The task is still working in the background. You will be notified automatically when it finishes.",
        "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work \u2014 avoid working with the same files or topics it is using.",
        "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
      ]
    : [
        "The task is working in the background. You will be notified automatically when it finishes.",
        "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work \u2014 avoid working with the same files or topics it is using.",
        "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
      ];
  return [
    `<task id="${childId}" state="running">`,
    `<summary>Background task ${updated ? "updated" : "started"}</summary>`,
    "<task_result>",
    ...detail,
    "</task_result>",
    "</task>",
  ].join("\n");
}

export function verifyOpenCodeTask(input: {
  readonly name: unknown;
  readonly parameters: unknown;
  readonly output: unknown;
  readonly metadata: unknown;
  readonly identity: OpenCodeTaskIdentity;
}): OpenCodeTaskDescriptor | undefined {
  const parameters = taskInput(input.parameters);
  const metadata = objectValue(input.metadata);
  const childId = metadata?.sessionId;
  const model = taskModel(metadata?.model);
  if (
    input.name !== "task" || parameters === undefined || typeof input.output !== "string" ||
    metadata === undefined || typeof childId !== "string" || childId === "" ||
    childId === input.identity.sessionId || metadata.parentSessionId !== input.identity.sessionId ||
    model === undefined || (metadata.truncated !== undefined && metadata.truncated !== false)
  ) return undefined;

  if (parameters.background === true) {
    const updated = parameters.task_id !== undefined;
    if (
      !hasOnlyFields(metadata, ["parentSessionId", "sessionId", "model", "background", "jobId", "truncated"]) ||
      metadata.background !== true || metadata.jobId !== childId ||
      (updated && parameters.task_id !== childId) ||
      input.output !== backgroundRunningOutput(childId, updated)
    ) return undefined;
    return {
      kind: updated ? "background_updated" : "background_started",
      childId,
      description: parameters.description as string,
    };
  }

  const foreground = projectedOpenCodeForegroundTask(parameters, input.output);
  if (
    foreground === undefined || foreground.childId !== childId ||
    !hasOnlyFields(metadata, ["parentSessionId", "sessionId", "model", "truncated"])
  ) return undefined;
  return foreground;
}

export function projectedOpenCodeForegroundTask(
  input: unknown,
  output: unknown,
): OpenCodeTaskDescriptor | undefined {
  const parameters = taskInput(input);
  if (
    parameters === undefined ||
    parameters.background !== undefined && parameters.background !== false ||
    typeof output !== "string"
  ) return undefined;
  const match = /^<task id="([^"\r\n]+)" state="completed">\n<task_result>\n[\s\S]*\n<\/task_result>\n<\/task>$/.exec(output);
  const childId = match?.[1];
  const resumed = parameters.task_id !== undefined;
  if (childId === undefined || (resumed && parameters.task_id !== childId)) return undefined;
  return {
    kind: resumed ? "foreground_resumed" : "foreground_completed",
    childId,
    description: parameters.description as string,
  };
}

export function projectedOpenCodeBackgroundTask(
  input: unknown,
  output: unknown,
): OpenCodeTaskDescriptor | undefined {
  const parameters = taskInput(input);
  if (
    parameters === undefined || parameters.background !== true || typeof output !== "string"
  ) return undefined;
  const match = /^<task id="([^"\r\n]+)" state="running">/.exec(output);
  const childId = match?.[1];
  const updated = parameters.task_id !== undefined;
  if (
    childId === undefined || (updated && parameters.task_id !== childId) ||
    output !== backgroundRunningOutput(childId, updated)
  ) return undefined;
  return {
    kind: updated ? "background_updated" : "background_started",
    childId,
    description: parameters.description as string,
  };
}

export function isOpenCodeBackgroundTaskNotification(
  text: string,
  task: OpenCodeTaskDescriptor,
): boolean {
  const completed = [
    `<task id="${task.childId}" state="completed">`,
    `<summary>Background task completed: ${task.description}</summary>`,
    "<task_result>",
  ].join("\n");
  const failed = [
    `<task id="${task.childId}" state="error">`,
    `<summary>Background task failed: ${task.description}</summary>`,
    "<task_error>",
  ].join("\n");
  return (
    text.startsWith(`${completed}\n`) && text.endsWith("\n</task_result>\n</task>")
  ) || (
    text.startsWith(`${failed}\n`) && text.endsWith("\n</task_error>\n</task>")
  );
}
