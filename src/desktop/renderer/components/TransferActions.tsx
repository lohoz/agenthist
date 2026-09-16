import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Download, LoaderCircle, MoreHorizontal, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AgentHistDesktopApi,
  DesktopError,
  ImportPlanDto,
} from "../../contracts.js";
import {
  TransferDialog,
  type CompletedImport,
  type ImportTargetSelection,
} from "./TransferDialog.js";

interface TransferActionsProps {
  readonly api: AgentHistDesktopApi;
  readonly onNotice: (message: string) => void;
  readonly onImported: () => void;
}

type ImportOperationKind = "open" | "replan" | "map" | "apply";

interface ImportOperationToken {
  readonly id: number;
  readonly kind: ImportOperationKind;
  readonly handle?: string;
}

export function TransferActions({ api, onNotice, onImported }: TransferActionsProps) {
  const [exporting, setExporting] = useState(false);
  const [openingImport, setOpeningImport] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [plan, setPlan] = useState<ImportPlanDto>();
  const [completed, setCompleted] = useState<CompletedImport>();
  const [target, setTarget] = useState<ImportTargetSelection>("original");
  const [selectedImports, setSelectedImports] = useState<ReadonlySet<string>>(() => new Set());
  const [allowLossy, setAllowLossy] = useState(false);
  const [replanning, setReplanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [mappingSources, setMappingSources] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<DesktopError>();
  const [reviewMessage, setReviewMessage] = useState<string>();
  const activeHandle = useRef<string | undefined>(undefined);
  const mappingSourcesRef = useRef<ReadonlySet<string>>(new Set());
  const requestGeneration = useRef(0);
  const operationSequence = useRef(0);
  const activeOperation = useRef<ImportOperationToken | undefined>(undefined);
  const cancelHandleRef = useRef<(handle: string, reportFailure: boolean) => Promise<void>>(async () => {});

  const beginOperation = (kind: ImportOperationKind, handle?: string): ImportOperationToken | undefined => {
    if (activeOperation.current !== undefined) return undefined;
    const token: ImportOperationToken = {
      id: ++operationSequence.current,
      kind,
      ...(handle === undefined ? {} : { handle }),
    };
    activeOperation.current = token;
    return token;
  };

  const ownsOperation = (token: ImportOperationToken): boolean => activeOperation.current === token;

  const finishOperation = (token: ImportOperationToken): boolean => {
    if (!ownsOperation(token)) return false;
    activeOperation.current = undefined;
    return true;
  };

  const cancelHandle = useCallback(async (handle: string, reportFailure: boolean): Promise<void> => {
    try {
      const result = await api.cancelImport({ handle });
      if (reportFailure && !result.ok) onNotice(`无法关闭导入 · ${result.error.message}`);
    } catch {
      if (reportFailure) onNotice("无法安全关闭导入。" );
    }
  }, [api, onNotice]);
  cancelHandleRef.current = cancelHandle;

  useEffect(() => () => {
    requestGeneration.current += 1;
    activeOperation.current = undefined;
    const handle = activeHandle.current;
    activeHandle.current = undefined;
    if (handle !== undefined) void cancelHandleRef.current(handle, false);
  }, []);

  const resetDialog = (): void => {
    setPlan(undefined);
    setCompleted(undefined);
    setTarget("original");
    setSelectedImports(new Set());
    setAllowLossy(false);
    setReplanning(false);
    setApplying(false);
    mappingSourcesRef.current = new Set();
    setMappingSources(new Set());
    setError(undefined);
    setReviewMessage(undefined);
  };

  const setMappingBusy = (source: string, busy: boolean): void => {
    const next = new Set(mappingSourcesRef.current);
    if (busy) next.add(source);
    else next.delete(source);
    mappingSourcesRef.current = next;
    setMappingSources(next);
  };

  const closeDialog = (): void => {
    if (applying || activeOperation.current?.kind === "apply") return;
    activeOperation.current = undefined;
    requestGeneration.current += 1;
    const handle = activeHandle.current;
    activeHandle.current = undefined;
    setDialogOpen(false);
    resetDialog();
    if (handle !== undefined) void cancelHandle(handle, true);
  };

  const exportAll = async (): Promise<void> => {
    if (exporting) return;
    setExporting(true);
    try {
      const result = await api.exportHistory({ scope: "all" });
      if (!result.ok) onNotice(`导出失败 · ${result.error.message}`);
      else if (result.value.status === "cancelled") onNotice("已取消导出");
      else onNotice(`已导出 ${result.value.entries} 个对话`);
    } catch {
      onNotice("导出失败 · 桌面桥接没有完成请求。" );
    } finally {
      setExporting(false);
    }
  };

  const openImport = async (): Promise<void> => {
    if (openingImport || activeHandle.current !== undefined) return;
    const operation = beginOperation("open");
    if (operation === undefined) return;
    setOpeningImport(true);
    const generation = ++requestGeneration.current;
    try {
      const result = await api.openImport();
      if (generation !== requestGeneration.current || !ownsOperation(operation)) {
        if (result.ok && result.value.status === "planned") {
          if (activeHandle.current !== result.value.plan.handle) {
            await cancelHandle(result.value.plan.handle, false);
          }
        }
        return;
      }
      if (!result.ok) {
        onNotice(`导入失败 · ${result.error.message}`);
        return;
      }
      if (result.value.status === "cancelled") {
        onNotice("已取消导入");
        return;
      }
      activeHandle.current = result.value.plan.handle;
      resetDialog();
      setPlan(result.value.plan);
      setSelectedImports(new Set(result.value.plan.sessions.filter((session) => session.selected).flatMap((session) => session.memberSessionRefs)));
      setDialogOpen(true);
    } catch {
      if (generation === requestGeneration.current && ownsOperation(operation)) {
        onNotice("导入失败 · 桌面桥接没有完成请求。" );
      }
    } finally {
      if (finishOperation(operation)) setOpeningImport(false);
    }
  };

  const replan = async (
    selection: ImportTargetSelection,
    sessionRefs: readonly string[] = [...selectedImports],
    lossy = allowLossy,
  ): Promise<void> => {
    const handle = activeHandle.current;
    if (handle === undefined || replanning || applying || mappingSourcesRef.current.size > 0) return;
    const operation = beginOperation("replan", handle);
    if (operation === undefined) return;
    const previousTarget = target;
    const previousSessions = selectedImports;
    const previousLossy = allowLossy;
    setTarget(selection);
    setSelectedImports(new Set(sessionRefs));
    setAllowLossy(lossy);
    setReplanning(true);
    setError(undefined);
    setReviewMessage(undefined);
    const generation = ++requestGeneration.current;
    try {
      const result = await api.replanImport({
        handle,
        ...(selection === "original" ? {} : { targetAgent: selection }),
        sessionRefs,
        ...(lossy ? { allowLossyConversion: true } : {}),
      });
      if (generation !== requestGeneration.current || !ownsOperation(operation)) {
        if (result.ok && activeHandle.current !== result.value.handle) {
          await cancelHandle(result.value.handle, false);
        }
        return;
      }
      if (!result.ok) {
        setTarget(previousTarget);
        setSelectedImports(previousSessions);
        setAllowLossy(previousLossy);
        setError(result.error);
        return;
      }
      activeHandle.current = result.value.handle;
      setPlan(result.value);
      setSelectedImports(new Set(result.value.sessions.filter((session) => session.selected).flatMap((session) => session.memberSessionRefs)));
      setReviewMessage("选择或转换方式已更新，请重新检查预览后再导入。");
    } catch (caught) {
      if (generation === requestGeneration.current && ownsOperation(operation)) {
        setTarget(previousTarget);
        setSelectedImports(previousSessions);
        setAllowLossy(previousLossy);
        setError(bridgeError(caught, "无法重新规划导入。"));
      }
    } finally {
      if (finishOperation(operation)) setReplanning(false);
    }
  };

  const mapWorkspace = async (source: string): Promise<void> => {
    const handle = activeHandle.current;
    if (handle === undefined || replanning || applying || mappingSourcesRef.current.size > 0) return;
    const operation = beginOperation("map", handle);
    if (operation === undefined) return;
    setMappingBusy(source, true);
    setError(undefined);
    setReviewMessage(undefined);
    const generation = ++requestGeneration.current;
    try {
      const result = await api.mapImportWorkspace({ handle, source });
      if (generation !== requestGeneration.current || !ownsOperation(operation)) {
        if (result.ok && result.value.status === "planned") {
          if (activeHandle.current !== result.value.plan.handle) {
            await cancelHandle(result.value.plan.handle, false);
          }
        }
        return;
      }
      if (!result.ok) {
        setError(publicDesktopError(result.error));
        return;
      }
      if (result.value.status === "cancelled") return;
      activeHandle.current = result.value.plan.handle;
      setPlan(result.value.plan);
      setSelectedImports(new Set(result.value.plan.sessions.filter((session) => session.selected).flatMap((session) => session.memberSessionRefs)));
      setReviewMessage("工作区映射已更新，请重新检查预览。" );
    } catch {
      if (generation === requestGeneration.current && ownsOperation(operation)) {
        setError(bridgeError(undefined, "无法选择工作区文件夹。"));
      }
    } finally {
      if (finishOperation(operation)) setMappingBusy(source, false);
    }
  };

  const apply = async (): Promise<void> => {
    const current = plan;
    const handle = activeHandle.current;
    const unresolvedWorkspace = current?.workspaces.some((workspace) =>
      workspace.status === "missing" || workspace.status === "unmapped") ?? true;
    if (current === undefined || handle === undefined || applying || replanning || mappingSourcesRef.current.size > 0 || current.status === "blocked" ||
      current.blocked > 0 || current.conflicts > 0 || unresolvedWorkspace) return;
    const operation = beginOperation("apply", handle);
    if (operation === undefined) return;
    setApplying(true);
    setError(undefined);
    setReviewMessage(undefined);
    const generation = ++requestGeneration.current;
    try {
      const result = await api.applyImport({ handle, expectedPlanRef: current.planRef });
      if (generation !== requestGeneration.current || !ownsOperation(operation)) {
        if (result.ok && result.value.status === "completed") {
          onImported();
          onNotice(`导入已在后台完成 · 已写入 ${result.value.written} 个对话`);
          return;
        }
        if (result.ok && result.value.status !== "completed") {
          if (activeHandle.current !== result.value.plan.handle) {
            await cancelHandle(result.value.plan.handle, false);
          }
        }
        return;
      }
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.value.status === "completed") {
        activeHandle.current = undefined;
        setCompleted(result.value);
        onImported();
        return;
      }
      activeHandle.current = result.value.plan.handle;
      setPlan(result.value.plan);
      setReviewMessage(result.value.status === "replan_required"
        ? "归档计划发生变化，请检查更新后的计划再确认。"
        : "更新后的计划被阻止，未写入任何内容。" );
    } catch (caught) {
      if (generation === requestGeneration.current && ownsOperation(operation)) {
        setError(bridgeError(caught, "无法执行导入。"));
      }
    } finally {
      if (finishOperation(operation)) setApplying(false);
    }
  };

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button className="quiet-icon-button" type="button" aria-label="导入与导出">
            {openingImport || exporting ? <LoaderCircle className="spin" size={16} /> : <MoreHorizontal size={17} />}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="action-menu" sideOffset={6} align="end">
            <DropdownMenu.Item disabled={openingImport || exporting} onSelect={() => void openImport()}>
              <Upload size={14} /><span>{openingImport ? "正在打开…" : "导入…"}</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item disabled={openingImport || exporting} onSelect={() => void exportAll()}>
              <Download size={14} /><span>{exporting ? "正在导出…" : "导出全部…"}</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <TransferDialog
        open={dialogOpen}
        plan={plan}
        completed={completed}
        target={target}
        replanning={replanning}
        applying={applying}
        mappingSources={mappingSources}
        selectedSessionRefs={selectedImports}
        allowLossy={allowLossy}
        error={error}
        reviewMessage={reviewMessage}
        onOpenChange={(open) => { if (!open && !applying) closeDialog(); }}
        onTargetChange={(selection) => void replan(selection)}
        onSelectionChange={(references) => void replan(target, references, allowLossy)}
        onAllowLossy={() => void replan(target, [...selectedImports], true)}
        onMapWorkspace={(source) => void mapWorkspace(source)}
        onApply={() => void apply()}
      />
    </>
  );
}

function bridgeError(error: unknown, fallback: string): DesktopError {
  return {
    code: "renderer.bridge_failed",
    message: error instanceof Error && error.message.trim() !== "" ? error.message : fallback,
    retryable: true,
  };
}

function publicDesktopError(error: DesktopError): DesktopError {
  return { code: error.code, message: error.message, retryable: error.retryable };
}
