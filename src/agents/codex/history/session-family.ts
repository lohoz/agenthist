function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

// Forks alone are independent conversations. Only explicit subagent ancestry
// connects a thread to its parent conversation.
export function codexParentThreadId(native: unknown, nativeId: string): string | undefined {
  const metadata = record(native);
  const lineage = record(metadata?.lineage);
  const spawn = record(metadata?.spawn);
  const incoming = spawn?.relationStatus === "valid" ? record(spawn.incoming) : undefined;
  const parent = lineage?.parentThreadId ?? (
    incoming?.child_thread_id === nativeId ? incoming.parent_thread_id : undefined
  );
  return typeof parent === "string" && parent !== "" && parent !== nativeId ? parent : undefined;
}
