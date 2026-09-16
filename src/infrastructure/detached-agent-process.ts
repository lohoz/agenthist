import { closeSync, constants, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { access, lstat, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import spawn from "cross-spawn";

import type { AgentLaunchSpec } from "../agents/contracts.js";
import { pathFlavorForPlatform, pathImplementation } from "../domain/host-path.js";
import { resolveExecutable } from "./executable.js";

const MAX_COMMAND_BYTES = 32 * 1024;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_ARGUMENTS = 256;
const MAX_WORKSPACE_BYTES = 64 * 1024;
const MAX_WINDOWS_LAUNCH_PLAN_CHARACTERS = 24 * 1024;
const WINDOWS_LAUNCH_PLAN_ENVIRONMENT = "AGENTHIST_DESKTOP_WINDOWS_LAUNCH_PLAN";
const WINDOWS_LAUNCH_PLAN_SCHEMA = "agenthist.windows-terminal-launch/v1";
const WINDOWS_TERMINAL_RUNNER_ARGUMENT = "--agenthist-windows-terminal-runner";
const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";
const CURRENT_MODULE = fileURLToPath(import.meta.url);

// The fixed Windows PowerShell host detaches from any inherited console,
// allocates a visible one, and replaces Node's ignored stdio with inheritable
// CONIN$/CONOUT$ handles. It then starts this bundled module in Electron's
// Node mode; that runner uses cross-spawn with the already-resolved executable
// and the original argument array (including npm .cmd shims). No launch value
// is interpolated into this script: the plan arrives as base64 JSON in one
// private environment variable.
const WINDOWS_TERMINAL_HOST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'

$native = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AgentHistInteractiveConsole {
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AllocConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeConsole();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetStdHandle(int standardHandle, IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);

    private static IntPtr OpenConsole(string name) {
        IntPtr handle = CreateFileW(
            name,
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            IntPtr.Zero,
            OPEN_EXISTING,
            0,
            IntPtr.Zero);
        if (handle == IntPtr.Zero || handle == new IntPtr(-1)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not open " + name);
        }
        if (!SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not make " + name + " inheritable");
        }
        return handle;
    }

    public static void Attach() {
        // The broker itself is short-lived. Always detach first so a Desktop
        // process started from a developer shell still creates a new window.
        FreeConsole();
        if (!AllocConsole()) {
            int error = Marshal.GetLastWin32Error();
            throw new Win32Exception(error, "Could not allocate an interactive console");
        }
        IntPtr input = OpenConsole("CONIN$");
        IntPtr output = OpenConsole("CONOUT$");
        if (!SetStdHandle(STD_INPUT_HANDLE, input) ||
            !SetStdHandle(STD_OUTPUT_HANDLE, output) ||
            !SetStdHandle(STD_ERROR_HANDLE, output)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not install interactive console handles");
        }
        if (!SetConsoleCtrlHandler(IntPtr.Zero, false)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not enable interactive console interrupts");
        }
    }
}
'@

Add-Type -TypeDefinition $native -Language CSharp
[AgentHistInteractiveConsole]::Attach()

$output = [Console]::OpenStandardOutput()
$writer = [IO.StreamWriter]::new($output, [Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
[Console]::SetOut($writer)
[Console]::SetError($writer)
$input = [Console]::OpenStandardInput()
[Console]::SetIn([IO.StreamReader]::new($input, [Console]::InputEncoding))

$encodedPlan = [Environment]::GetEnvironmentVariable('${WINDOWS_LAUNCH_PLAN_ENVIRONMENT}', 'Process')
if ([String]::IsNullOrWhiteSpace($encodedPlan)) { throw 'The AgentHist terminal launch plan is missing.' }
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPlan))
$plan = ConvertFrom-Json -InputObject $json
if ($plan.schemaVersion -ne '${WINDOWS_LAUNCH_PLAN_SCHEMA}') { throw 'The AgentHist terminal launch plan is invalid.' }

$workingDirectory = [string] $plan.cwd
$launchExecutable = [string] $plan.launchExecutable
$launchArguments = [string] $plan.launchArguments
if (-not [IO.Path]::IsPathRooted($launchExecutable) -or
    -not [IO.Path]::IsPathRooted($workingDirectory) -or
    $launchArguments.Contains([char] 0)) {
    throw 'The AgentHist terminal launch paths are invalid.'
}
[Environment]::CurrentDirectory = $workingDirectory
Set-Location -LiteralPath $workingDirectory
[Environment]::SetEnvironmentVariable('${WINDOWS_LAUNCH_PLAN_ENVIRONMENT}', $null, 'Process')
[Environment]::SetEnvironmentVariable('${ELECTRON_RUN_AS_NODE}', $null, 'Process')
if ($null -ne $plan.previousPlanEnvironment) {
    [Environment]::SetEnvironmentVariable(
        [string] $plan.previousPlanEnvironment.name,
        [string] $plan.previousPlanEnvironment.value,
        'Process')
}
if ($null -ne $plan.previousElectronRunAsNodeEnvironment) {
    [Environment]::SetEnvironmentVariable(
        [string] $plan.previousElectronRunAsNodeEnvironment.name,
        [string] $plan.previousElectronRunAsNodeEnvironment.value,
        'Process')
}
$startOptions = @{
    FilePath = $launchExecutable
    WorkingDirectory = $workingDirectory
    NoNewWindow = $true
    PassThru = $true
}
if (-not [String]::IsNullOrEmpty($launchArguments)) {
    $startOptions.ArgumentList = $launchArguments
}
$process = Start-Process @startOptions
$acknowledgementPath = $plan.acknowledgementPath
if ($null -ne $acknowledgementPath) {
    [IO.File]::WriteAllText([string] $acknowledgementPath, 'ready', [Text.UTF8Encoding]::new($false))
}
$process.WaitForExit()
exit [int] $process.ExitCode
`;

const WINDOWS_TERMINAL_HOST_COMMAND = Buffer
  .from(WINDOWS_TERMINAL_HOST_SCRIPT, "utf16le")
  .toString("base64");

export interface PreparedDetachedAgentLaunch {
  readonly command: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
}

export interface DetachedAgentProcessResult extends PreparedDetachedAgentLaunch {
  readonly pid: number;
}

export interface DetachedAgentSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly detached: boolean;
  readonly stdio: "ignore" | "inherit" | [number, number, number];
  readonly shell: false;
  readonly windowsHide: false;
}

export interface DetachedAgentChildProcess {
  readonly pid?: number;
  once(event: "spawn", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null) => void): this;
  removeListener(event: "spawn", listener: () => void): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "exit", listener: (code: number | null) => void): this;
  unref(): void;
}

export type DetachedAgentSpawner = (
  executable: string,
  args: readonly string[],
  options: DetachedAgentSpawnOptions,
) => DetachedAgentChildProcess;

export type DetachedExecutableResolver = (
  command: string,
  options: {
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly platform: NodeJS.Platform;
    readonly searchCurrentDirectory: false;
  },
) => Promise<string | undefined>;

export interface DetachedAgentProcessOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly resolveExecutable?: DetachedExecutableResolver;
  readonly spawn?: DetachedAgentSpawner;
  readonly terminal?: {
    readonly executablePath: string;
    readonly arguments: readonly string[];
  };
}

const defaultSpawner: DetachedAgentSpawner = (executable, args, options) =>
  spawn(executable, [...args], options) as DetachedAgentChildProcess;

function environmentKey(environment: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return Object.hasOwn(environment, name) ? name : undefined;
  return Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  const key = environmentKey(environment, name, platform);
  return key === undefined ? undefined : environment[key];
}

function withoutEnvironmentKey(
  environment: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  if (platform === "win32") {
    for (const key of Object.keys(result)) {
      if (key.toLowerCase() === name.toLowerCase()) delete result[key];
    }
  } else {
    delete result[name];
  }
  return result;
}

function pathInsideWorkspace(directory: string, workspace: string, platform: NodeJS.Platform): boolean {
  const implementation = pathImplementation(pathFlavorForPlatform(platform));
  const relative = implementation.relative(implementation.resolve(workspace), implementation.resolve(directory));
  return relative === "" || (
    !implementation.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${implementation.sep}`)
  );
}

function trustedEnvironment(
  source: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  const implementation = pathImplementation(pathFlavorForPlatform(platform));
  const sourceKey = environmentKey(source, "PATH", platform);
  const configured = environmentValue(source, "PATH", platform) ?? (
    platform === "win32"
      ? environmentValue(process.env, "PATH", platform) ?? ""
      : "/usr/bin:/bin"
  );
  const directories = configured.split(implementation.delimiter).flatMap((raw): string[] => {
    const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    if (unquoted === "") return [];
    const resolved = implementation.resolve(cwd, unquoted);
    return pathInsideWorkspace(resolved, cwd, platform) ? [] : [resolved];
  });
  if (platform === "win32") {
    for (const key of Object.keys(environment)) {
      if (key.toLowerCase() === "path") delete environment[key];
    }
  } else {
    delete environment.PATH;
  }
  environment[sourceKey ?? "PATH"] = directories.join(implementation.delimiter);
  return environment;
}

function validateLaunchSpec(spec: AgentLaunchSpec, platform: NodeJS.Platform): {
  readonly explicit: boolean;
  readonly cwd: string;
} {
  if (
    spec.command === "" || spec.command.includes("\0") ||
    Buffer.byteLength(spec.command, "utf8") > MAX_COMMAND_BYTES
  ) throw new Error("detached Agent command is invalid");
  if (!Array.isArray(spec.args) || spec.args.length > MAX_ARGUMENTS) {
    throw new Error("detached Agent argument list is invalid");
  }
  for (const argument of spec.args) {
    if (
      typeof argument !== "string" || argument.includes("\0") ||
      Buffer.byteLength(argument, "utf8") > MAX_ARGUMENT_BYTES
    ) throw new Error("detached Agent argument is invalid");
  }
  if (
    spec.cwd === "" || spec.cwd.includes("\0") ||
    Buffer.byteLength(spec.cwd, "utf8") > MAX_WORKSPACE_BYTES
  ) throw new Error("detached Agent workspace is invalid");
  const implementation = pathImplementation(pathFlavorForPlatform(platform));
  if (!implementation.isAbsolute(spec.cwd)) throw new Error("detached Agent workspace must be absolute");
  const explicit = implementation.isAbsolute(spec.command);
  const containsSeparator = spec.command.includes("/") || platform === "win32" && spec.command.includes("\\");
  if (!explicit && containsSeparator) {
    throw new Error("detached Agent command must be a trusted PATH name or an absolute path");
  }
  if (!explicit && !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,254}$/.test(spec.command)) {
    throw new Error("detached Agent PATH command is invalid");
  }
  return { explicit, cwd: implementation.normalize(spec.cwd) };
}

async function requireRealWorkspace(cwd: string): Promise<void> {
  let info;
  try {
    info = await lstat(cwd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`detached Agent workspace does not exist: ${cwd}`);
    }
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`detached Agent workspace is not a real directory: ${cwd}`);
  }
}

interface ResolvedDetachedAgentLaunch extends PreparedDetachedAgentLaunch {
  readonly environment: NodeJS.ProcessEnv;
}

interface WindowsLaunchPlan {
  readonly schemaVersion: typeof WINDOWS_LAUNCH_PLAN_SCHEMA;
  readonly nodeHost: string;
  readonly runner: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly launchExecutable: string;
  readonly launchArguments: string;
  readonly cwd: string;
  readonly acknowledgementPath: string | null;
  readonly previousPlanEnvironment: {
    readonly name: string;
    readonly value: string;
  } | null;
  readonly previousElectronRunAsNodeEnvironment: {
    readonly name: string;
    readonly value: string;
  } | null;
}

function windowsPowerShellExecutable(): string {
  const systemRoot = environmentValue(process.env, "SystemRoot", "win32");
  if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot) || systemRoot.includes("\0")) {
    throw new Error("Windows SystemRoot is unavailable for interactive Agent launch");
  }
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function quoteWindowsArgument(value: string): string {
  if (value !== "" && !/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, "$1$1\\\"").replace(/(\\+)$/u, "$1$1")}"`;
}

const WINDOWS_SHELL_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/gu;

function escapeWindowsShellCommand(value: string): string {
  return value.replace(WINDOWS_SHELL_META_CHARACTERS, "^$1");
}

function escapeWindowsShellArgument(value: string, doubleEscapeMetaCharacters: boolean): string {
  let escaped = value
    .replace(/(?=(\\+?)?)\1"/gu, "$1$1\\\"")
    .replace(/(?=(\\+?)?)\1$/u, "$1$1");
  escaped = `"${escaped}"`.replace(WINDOWS_SHELL_META_CHARACTERS, "^$1");
  return doubleEscapeMetaCharacters
    ? escaped.replace(WINDOWS_SHELL_META_CHARACTERS, "^$1")
    : escaped;
}

function windowsLeafInvocation(prepared: ResolvedDetachedAgentLaunch): {
  readonly executable: string;
  readonly arguments: string;
} {
  if (/\.(?:com|exe)$/iu.test(prepared.executable)) {
    return {
      executable: prepared.executable,
      arguments: prepared.args.map(quoteWindowsArgument).join(" "),
    };
  }
  const doubleEscapeMetaCharacters = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/iu.test(prepared.executable);
  const command = [
    escapeWindowsShellCommand(prepared.executable),
    ...prepared.args.map((argument) => escapeWindowsShellArgument(argument, doubleEscapeMetaCharacters)),
  ].join(" ");
  const systemRoot = environmentValue(prepared.environment, "SystemRoot", "win32") ??
    environmentValue(process.env, "SystemRoot", "win32");
  const executable = environmentValue(prepared.environment, "ComSpec", "win32") ??
    environmentValue(process.env, "ComSpec", "win32") ??
    (systemRoot === undefined ? undefined : path.win32.join(systemRoot, "System32", "cmd.exe"));
  if (executable === undefined || !path.win32.isAbsolute(executable) || executable.includes("\0")) {
    throw new Error("Windows command interpreter is unavailable for interactive Agent launch");
  }
  return { executable: path.win32.normalize(executable), arguments: `/d /s /c "${command}"` };
}

function windowsRunnerPlan(prepared: ResolvedDetachedAgentLaunch, acknowledgementPath?: string): {
  readonly encodedPlan: string;
  readonly environment: NodeJS.ProcessEnv;
} {
  const previousKey = environmentKey(prepared.environment, WINDOWS_LAUNCH_PLAN_ENVIRONMENT, "win32");
  const previousValue = previousKey === undefined ? undefined : prepared.environment[previousKey];
  const previousElectronKey = environmentKey(prepared.environment, ELECTRON_RUN_AS_NODE, "win32");
  const previousElectronValue = previousElectronKey === undefined
    ? undefined
    : prepared.environment[previousElectronKey];
  const launch = windowsLeafInvocation(prepared);
  const plan: WindowsLaunchPlan = {
    schemaVersion: WINDOWS_LAUNCH_PLAN_SCHEMA,
    nodeHost: process.execPath,
    runner: CURRENT_MODULE,
    executable: prepared.executable,
    arguments: prepared.args,
    launchExecutable: launch.executable,
    launchArguments: launch.arguments,
    cwd: prepared.cwd,
    acknowledgementPath: acknowledgementPath ?? null,
    previousPlanEnvironment: previousKey === undefined || previousValue === undefined
      ? null
      : { name: previousKey, value: previousValue },
    previousElectronRunAsNodeEnvironment: previousElectronKey === undefined || previousElectronValue === undefined
      ? null
      : { name: previousElectronKey, value: previousElectronValue },
  };
  const encodedPlan = Buffer.from(JSON.stringify(plan), "utf8").toString("base64");
  if (encodedPlan.length > MAX_WINDOWS_LAUNCH_PLAN_CHARACTERS) {
    throw new Error("Windows interactive Agent launch exceeds the supported command size");
  }
  const environment = {
    ...withoutEnvironmentKey(
      withoutEnvironmentKey(prepared.environment, WINDOWS_LAUNCH_PLAN_ENVIRONMENT, "win32"),
      ELECTRON_RUN_AS_NODE,
      "win32",
    ),
    [WINDOWS_LAUNCH_PLAN_ENVIRONMENT]: encodedPlan,
  };
  return { encodedPlan, environment };
}

async function windowsTerminalInvocation(
  prepared: ResolvedDetachedAgentLaunch,
): Promise<{
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}> {
  const hostExecutable = windowsPowerShellExecutable();
  const hostInfo = await lstat(hostExecutable);
  if (!hostInfo.isFile() || hostInfo.isSymbolicLink()) {
    throw new Error("Windows PowerShell terminal host is unavailable");
  }
  const runner = windowsRunnerPlan(prepared);
  return {
    executable: hostExecutable,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      WINDOWS_TERMINAL_HOST_COMMAND,
    ],
    environment: runner.environment,
  };
}

async function configuredWindowsTerminalInvocation(
  prepared: ResolvedDetachedAgentLaunch,
  terminal: NonNullable<DetachedAgentProcessOptions["terminal"]>,
): Promise<{
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly acknowledgementPath: string;
  readonly bootstrapPath: string;
}> {
  if (!path.win32.isAbsolute(terminal.executablePath) || terminal.arguments.length === 0 ||
    terminal.arguments.length > MAX_ARGUMENTS ||
    terminal.arguments.filter((argument) => argument === "{command}" || argument === "{commandLine}").length !== 1) {
    throw new Error("configured terminal launch template is invalid");
  }
  const executable = path.win32.normalize(terminal.executablePath);
  const info = await lstat(executable);
  const approvedWindowsTerminalAlias = /\\Microsoft\\WindowsApps\\wt\.exe$/iu.test(executable) &&
    !info.isDirectory();
  if ((!info.isFile() && !approvedWindowsTerminalAlias) ||
    info.isSymbolicLink() && !approvedWindowsTerminalAlias) {
    throw new Error("configured terminal executable is unavailable");
  }
  const acknowledgementPath = path.join(os.tmpdir(), `agenthist-terminal-${randomUUID()}.ack`);
  const runner = windowsRunnerPlan(prepared, acknowledgementPath);
  const bootstrapPath = path.join(os.tmpdir(), `agenthist-terminal-${randomUUID()}.json`);
  const bootstrapHost = windowsPowerShellExecutable();
  const bootstrapInfo = await lstat(bootstrapHost);
  if (!bootstrapInfo.isFile() || bootstrapInfo.isSymbolicLink()) {
    throw new Error("Windows terminal bootstrap host is unavailable");
  }
const encode = (value: string): string => Buffer.from(value, "utf8").toString("base64");
  const bootstrapScript = String.raw`
$ErrorActionPreference = 'Stop'
$bootstrapPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(bootstrapPath)}'))
try {
  $bootstrap = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($bootstrapPath, [Text.Encoding]::UTF8))
  foreach ($entry in $bootstrap.environment.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable([string] $entry.Name, [string] $entry.Value, 'Process')
  }
  $planJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string] $bootstrap.plan))
  $plan = ConvertFrom-Json -InputObject $planJson
} finally {
  [IO.File]::Delete($bootstrapPath)
}
$workingDirectory = [string] $plan.cwd
$launchExecutable = [string] $plan.launchExecutable
$launchArguments = [string] $plan.launchArguments
if ($plan.schemaVersion -ne '${WINDOWS_LAUNCH_PLAN_SCHEMA}' -or
    -not [IO.Path]::IsPathRooted($workingDirectory) -or
    -not [IO.Path]::IsPathRooted($launchExecutable) -or
    $launchArguments.Contains([char] 0)) {
  throw 'The AgentHist terminal launch plan is invalid.'
}
[Environment]::SetEnvironmentVariable('${WINDOWS_LAUNCH_PLAN_ENVIRONMENT}', $null, 'Process')
[Environment]::SetEnvironmentVariable('${ELECTRON_RUN_AS_NODE}', $null, 'Process')
if ($null -ne $plan.previousPlanEnvironment) {
  [Environment]::SetEnvironmentVariable(
    [string] $plan.previousPlanEnvironment.name,
    [string] $plan.previousPlanEnvironment.value,
    'Process')
}
if ($null -ne $plan.previousElectronRunAsNodeEnvironment) {
  [Environment]::SetEnvironmentVariable(
    [string] $plan.previousElectronRunAsNodeEnvironment.name,
    [string] $plan.previousElectronRunAsNodeEnvironment.value,
    'Process')
}
[Environment]::CurrentDirectory = $workingDirectory
Set-Location -LiteralPath $workingDirectory
$startOptions = @{
  FilePath = $launchExecutable
  WorkingDirectory = $workingDirectory
  NoNewWindow = $true
  PassThru = $true
}
if (-not [String]::IsNullOrEmpty($launchArguments)) {
  $startOptions.ArgumentList = $launchArguments
}
$process = Start-Process @startOptions
$acknowledgementPath = [string] $plan.acknowledgementPath
if ([String]::IsNullOrWhiteSpace($acknowledgementPath)) {
  throw 'The AgentHist terminal acknowledgement path is invalid.'
}
[IO.File]::WriteAllText($acknowledgementPath, 'ready', [Text.UTF8Encoding]::new($false))
$process.WaitForExit()
exit [int] $process.ExitCode
`;
  const command = [
    bootstrapHost,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(bootstrapScript, "utf16le").toString("base64"),
  ];
  const commandLine = command.map(quoteWindowsArgument).join(" ");
  const args = terminal.arguments.flatMap((argument): string[] => {
    if (typeof argument !== "string" || argument === "" || argument.includes("\0") ||
      Buffer.byteLength(argument, "utf8") > MAX_ARGUMENT_BYTES) {
      throw new Error("configured terminal argument is invalid");
    }
    if (argument === "{command}") return command;
    if (argument === "{commandLine}") return [commandLine];
    return [argument.replaceAll("{cwd}", prepared.cwd)];
  });
  await writeFile(bootstrapPath, JSON.stringify({
    plan: runner.encodedPlan,
    environment: runner.environment,
  }), { flag: "wx", mode: 0o600 });
  return {
    executable,
    args,
    environment: runner.environment,
    acknowledgementPath,
    bootstrapPath,
  };
}

function windowsLaunchPlanFromEnvironment(): WindowsLaunchPlan {
  const encoded = environmentValue(process.env, WINDOWS_LAUNCH_PLAN_ENVIRONMENT, "win32");
  if (encoded === undefined || encoded === "" || encoded.length > MAX_WINDOWS_LAUNCH_PLAN_CHARACTERS) {
    throw new Error("Windows interactive Agent launch plan is missing or invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    throw new Error("Windows interactive Agent launch plan is invalid");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Windows interactive Agent launch plan is invalid");
  }
  const plan = value as Partial<WindowsLaunchPlan>;
  if (
    plan.schemaVersion !== WINDOWS_LAUNCH_PLAN_SCHEMA || typeof plan.nodeHost !== "string" ||
    typeof plan.runner !== "string" || typeof plan.executable !== "string" ||
    typeof plan.launchExecutable !== "string" || typeof plan.launchArguments !== "string" ||
    typeof plan.cwd !== "string" || !Array.isArray(plan.arguments) ||
    plan.arguments.some((argument) => typeof argument !== "string") ||
    !path.win32.isAbsolute(plan.executable) || !path.win32.isAbsolute(plan.launchExecutable) ||
    !path.win32.isAbsolute(plan.cwd) || plan.launchArguments.includes("\0") ||
    !(plan.acknowledgementPath === null || typeof plan.acknowledgementPath === "string" &&
      /^agenthist-terminal-[0-9a-f-]{36}\.ack$/iu.test(path.win32.basename(plan.acknowledgementPath)) &&
      path.win32.normalize(path.win32.dirname(plan.acknowledgementPath)).toLowerCase() ===
        path.win32.normalize(os.tmpdir()).toLowerCase())
  ) throw new Error("Windows interactive Agent launch plan is invalid");
  return plan as WindowsLaunchPlan;
}

function restoreEnvironmentEntry(
  environment: NodeJS.ProcessEnv,
  entry: WindowsLaunchPlan["previousPlanEnvironment"],
): void {
  if (entry !== null) environment[entry.name] = entry.value;
}

async function runWindowsTerminalChild(): Promise<void> {
  const plan = windowsLaunchPlanFromEnvironment();
  const environment = withoutEnvironmentKey(
    withoutEnvironmentKey(process.env, WINDOWS_LAUNCH_PLAN_ENVIRONMENT, "win32"),
    ELECTRON_RUN_AS_NODE,
    "win32",
  );
  restoreEnvironmentEntry(environment, plan.previousPlanEnvironment);
  restoreEnvironmentEntry(environment, plan.previousElectronRunAsNodeEnvironment);
  await new Promise<void>((resolve, reject) => {
    const input = openSync("\\\\.\\CONIN$", constants.O_RDWR);
    const output = openSync("\\\\.\\CONOUT$", constants.O_RDWR);
    let child: DetachedAgentChildProcess;
    try {
      child = defaultSpawner(plan.executable, plan.arguments, {
        cwd: plan.cwd,
        env: environment,
        detached: false,
        stdio: [input, output, output],
        shell: false,
        windowsHide: false,
      });
    } catch (error) {
      closeSync(input);
      closeSync(output);
      reject(error);
      return;
    }
    closeSync(input);
    closeSync(output);
    child.once("error", reject);
    child.once("spawn", () => {
      if (plan.acknowledgementPath === null) return;
      void writeFile(plan.acknowledgementPath, "ready", { flag: "wx", mode: 0o600 }).catch(reject);
    });
    child.once("exit", (code: number | null) => {
      process.exitCode = code === null ? 1 : code;
      resolve();
    });
  });
}

function isWindowsTerminalRunner(): boolean {
  const entry = process.argv[1];
  return process.platform === "win32" && entry !== undefined &&
    path.win32.normalize(entry).toLowerCase() === path.win32.normalize(CURRENT_MODULE).toLowerCase() &&
    process.argv[2] === WINDOWS_TERMINAL_RUNNER_ARGUMENT;
}

async function resolveDetachedAgentLaunch(
  spec: AgentLaunchSpec,
  options: DetachedAgentProcessOptions = {},
): Promise<ResolvedDetachedAgentLaunch> {
  const platform = options.platform ?? process.platform;
  const validated = validateLaunchSpec(spec, platform);
  await requireRealWorkspace(validated.cwd);
  const environment = trustedEnvironment(options.environment ?? process.env, validated.cwd, platform);
  const resolver = options.resolveExecutable ?? resolveExecutable;
  const executable = await resolver(spec.command, {
    cwd: validated.cwd,
    environment,
    platform,
    searchCurrentDirectory: false,
  });
  if (executable === undefined) {
    throw new Error(`${spec.command} is not installed or is not available on trusted PATH`);
  }
  const implementation = pathImplementation(pathFlavorForPlatform(platform));
  if (!implementation.isAbsolute(executable)) {
    throw new Error("detached Agent executable resolution returned a relative path");
  }
  const normalizedExecutable = implementation.normalize(executable);
  if (!validated.explicit && pathInsideWorkspace(normalizedExecutable, validated.cwd, platform)) {
    throw new Error(
      `${spec.command} resolved inside the workspace; configure an explicit absolute executable path to allow it`,
    );
  }
  return {
    command: spec.command,
    executable: normalizedExecutable,
    args: [...spec.args],
    cwd: validated.cwd,
    platform,
    environment,
  };
}

export async function prepareDetachedAgentLaunch(
  spec: AgentLaunchSpec,
  options: DetachedAgentProcessOptions = {},
): Promise<PreparedDetachedAgentLaunch> {
  const { environment: _environment, ...prepared } = await resolveDetachedAgentLaunch(spec, options);
  return prepared;
}

const MACOS_TERMINAL_SCRIPT = `on run argv
  set commandText to "cd " & quoted form of (item 1 of argv) & " && exec"
  repeat with i from 2 to count of argv
    set commandText to commandText & " " & quoted form of (item i of argv)
  end repeat
  tell application "Terminal"
    activate
    do script commandText
  end tell
end run`;

async function posixTerminalInvocation(prepared: ResolvedDetachedAgentLaunch, terminal: NonNullable<DetachedAgentProcessOptions["terminal"]>) {
  if (!path.posix.isAbsolute(terminal.executablePath) || terminal.arguments.filter((argument) => argument === "{command}" || argument === "{commandLine}").length !== 1) {
    throw new Error("configured terminal launch template is invalid");
  }
  await access(terminal.executablePath, constants.X_OK);
  if (prepared.platform === "darwin" && terminal.executablePath === "/usr/bin/osascript") {
    const profileEnvironment = ["PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]
      .flatMap((key) => prepared.environment[key] === undefined ? [] : [`${key}=${prepared.environment[key]}`]);
    return { executable: terminal.executablePath,
      args: ["-e", MACOS_TERMINAL_SCRIPT, "--", prepared.cwd, "/usr/bin/env", ...profileEnvironment, prepared.executable, ...prepared.args],
      environment: prepared.environment };
  }
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const args = terminal.arguments.flatMap((argument) => {
    if (/[\u0000-\u001f\u007f]/u.test(argument)) throw new Error("configured terminal argument is invalid");
    if (argument === "{command}") return [prepared.executable, ...prepared.args];
    if (argument === "{commandLine}") return [[prepared.executable, ...prepared.args].map(quote).join(" ")];
    return [argument.replaceAll("{cwd}", prepared.cwd)];
  });
  return { executable: terminal.executablePath, args, environment: prepared.environment };
}

export async function launchDetachedAgentProcess(
  spec: AgentLaunchSpec,
  options: DetachedAgentProcessOptions = {},
): Promise<DetachedAgentProcessResult> {
  const prepared = await resolveDetachedAgentLaunch(spec, options);
  const invocation = prepared.platform === "win32"
    ? options.terminal === undefined
      ? await windowsTerminalInvocation(prepared)
      : await configuredWindowsTerminalInvocation(prepared, options.terminal)
    : options.terminal === undefined ? { executable: prepared.executable, args: prepared.args, environment: prepared.environment }
      : await posixTerminalInvocation(prepared, options.terminal);
  const spawner = options.spawn ?? defaultSpawner;
  const spawnInvocation = (selected: typeof invocation): Promise<number> => new Promise((resolve, reject) => {
    let child: DetachedAgentChildProcess;
    try {
      child = spawner(selected.executable, selected.args, {
        cwd: prepared.cwd,
        env: selected.environment,
        detached: prepared.platform !== "win32",
        stdio: "ignore",
        shell: false,
        windowsHide: false,
      });
    } catch (error) {
      reject(error);
      return;
    }
    const onError = (error: Error): void => {
      child.removeListener("spawn", onSpawn);
      const code = (error as NodeJS.ErrnoException).code;
      reject(code === "ENOENT"
        ? new Error(`${spec.command} is not installed or is not available on trusted PATH`)
        : error);
    };
    const onSpawn = (): void => {
      const pid = child.pid;
      if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
        reject(new Error("detached Agent process did not report a valid process ID"));
        return;
      }
      child.unref();
      resolve(pid);
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
  const acknowledgementPath = "acknowledgementPath" in invocation &&
    typeof invocation.acknowledgementPath === "string"
    ? invocation.acknowledgementPath
    : undefined;
  const bootstrapPath = "bootstrapPath" in invocation && typeof invocation.bootstrapPath === "string"
    ? invocation.bootstrapPath
    : undefined;
  let pid: number;
  try {
    pid = await spawnInvocation(invocation);
  } catch (error) {
    if (acknowledgementPath !== undefined) await rm(acknowledgementPath, { force: true });
    if (bootstrapPath !== undefined) await rm(bootstrapPath, { force: true });
    throw error;
  }
  if (acknowledgementPath !== undefined) {
    const deadline = Date.now() + 4_000;
    let acknowledged = false;
    while (Date.now() < deadline) {
      try {
        await access(acknowledgementPath);
        acknowledged = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }
    await rm(acknowledgementPath, { force: true });
    if (bootstrapPath !== undefined) await rm(bootstrapPath, { force: true });
    if (!acknowledged) {
      throw new Error("configured terminal did not start the Coding Agent");
    }
  }
  return {
    command: prepared.command,
    executable: prepared.executable,
    args: prepared.args,
    cwd: prepared.cwd,
    platform: prepared.platform,
    pid,
  };
}

if (isWindowsTerminalRunner()) {
  void runWindowsTerminalChild().catch(() => {
    process.stderr.write("AgentHist could not start the Coding Agent.\n");
    process.exitCode = 1;
  });
}
