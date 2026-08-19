export {
  prepareClaudeArchive,
  validateClaudeArchiveEntries,
  validateClaudeArchiveObjects,
} from "./migration/archive.js";
export { discoverClaudeCarriers } from "./carrier.js";
export { prepareClaudePortableSource } from "./conversion/portable.js";
export {
  projectPortableContextToClaude,
  writeClaudePortableProjection,
} from "./conversion/portable-projector.js";
export type { ClaudePortableProjection } from "./conversion/portable-projector.js";
export { prepareClaudeRestore } from "./migration/restore.js";
export type { PreparedClaudeRestore, RestoreClaudeResult } from "./migration/restore.js";
export { scanClaude } from "./scan.js";
export { requireClaudeSource, resolveClaudeSource } from "./source.js";
export {
  previewClaudeRecovery,
  previewClaudeRollback,
  recoverClaudeTransaction,
  rollbackClaudeTransaction,
} from "./migration/transaction.js";
export type { ClaudeTransactionPreview } from "./migration/transaction.js";
