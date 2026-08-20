import type { Agent } from "../domain/agent.js";
import type { ConversationItem, LibraryState } from "../domain/history.js";

export interface HistoryCatalogEntry {
  readonly sessionRef: string;
  readonly agent: Agent;
  readonly nativeId: string;
  readonly title: string;
  readonly workspace: string;
  readonly model: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nativeArchived: boolean;
  readonly libraryState: LibraryState;
  readonly tags: readonly string[];
  readonly resourceCount: number;
}

export interface HistorySessionPreview extends HistoryCatalogEntry {
  readonly conversation: readonly ConversationItem[];
}

export interface HistorySelectionCatalog {
  readonly entries: readonly HistoryCatalogEntry[];
  closeSelection(sessionRefs: readonly string[]): readonly HistoryCatalogEntry[];
  preview(sessionRef: string): Promise<HistorySessionPreview>;
}
