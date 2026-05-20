import { CustomEditor, type ExtensionAPI, type ExtensionContext, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BUILTIN_COMMAND_PALETTE_ITEMS, CommandPaletteOverlay, type CommandPaletteItem, type CommandPaletteItemsProvider, type CommandPalettePreviewProvider, type CommandPaletteResult, stripAnsi } from "./amp-command-palette.js";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

const MIN_BODY_LINES = 2;
const GIT_CACHE_MS = 2000;
const STATUS_LEFT_INSET = 1;
const STATUS_RIGHT_INSET = 1;
const WORKING_FRAMES = ["   ", ".  ", ".. ", "..."];
const WORKING_EMOJIS = [
  "( ͡° ͜ʖ ͡°)",
  "(╯°□°)╯",
  "(´・ω・`)",
  "ᕕ( ͡° ͜ʖ ͡°)ᕗ",
  "( ͡~ ͜ʖ ͡°)",
];
const WORKING_MESSAGES = [
  "Consulting the oracle",
  "Summoning tokens",
  "Wrangling neurons",
  "Shaking the magic 8-ball",
  "Asking nicely",
  "Bribing the transformer",
  "Warming up the hamsters",
  "Percolating thoughts",
  "Downloading more RAM",
  "Consulting the ancient scrolls",
  "Sacrificing tokens to the void",
  "Poking the language model",
  "Brewing a fresh response",
  "Loading galaxy brain",
  "Tickling the attention heads",
];
const MAX_AT_MENTION_ITEMS = 15;
const MAX_AT_PREVIEW_BYTES = 16 * 1024;
const MAX_AT_PREVIEW_LINES = 10;
const MAX_SKILL_PREVIEW_LINES = 10;

type WorkingState = {
  active: boolean;
  message: string;
  frame: string;
  emoji: string;
};

type GitInfo = {
  branch: string | null;
  changedFiles: number;
  added: number;
  modified: number;
  removed: number;
};

type UsageCost = {
  total: number;
  hasCost: boolean;
  usingSubscription: boolean;
};

let gitCache: { cwd: string; at: number; info: GitInfo } | undefined;

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    }).trim();
  } catch {
    return "";
  }
}

function getFdCommand(): string {
  const agentFd = `${homedir()}/.pi/agent/bin/fd`;
  return existsSync(agentFd) ? agentFd : "fd";
}

function toDisplayPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function getScopedAtMentionQuery(cwd: string, query: string): { baseDir: string; displayBase: string; query: string } | null {
  const normalizedQuery = toDisplayPath(query.trim());
  if (normalizedQuery === "~") return { baseDir: homedir(), displayBase: "~/", query: "" };

  const slashIndex = normalizedQuery.lastIndexOf("/");
  if (slashIndex === -1) return null;

  const displayBase = normalizedQuery.slice(0, slashIndex + 1);
  const tailQuery = normalizedQuery.slice(slashIndex + 1);
  const baseDir = displayBase.startsWith("~/")
    ? expandHomePath(displayBase)
    : displayBase.startsWith("/")
      ? displayBase
      : resolve(cwd, displayBase);

  try {
    if (!statSync(baseDir).isDirectory()) return null;
  } catch {
    return null;
  }

  return { baseDir, displayBase, query: tailQuery };
}

function scopedPathForDisplay(displayBase: string, relativePath: string): string {
  const normalized = toDisplayPath(relativePath);
  if (displayBase === "/") return `/${normalized}`;
  return `${toDisplayPath(displayBase)}${normalized}`;
}

async function getAtMentionItems(cwd: string, query = "", signal: AbortSignal): Promise<CommandPaletteItem[]> {
  const scoped = getScopedAtMentionQuery(cwd, query);
  const baseDir = scoped?.baseDir ?? cwd;
  const fdQuery = scoped?.query ?? query.trim();
  const args = [
    "--base-directory",
    baseDir,
    "--max-results",
    String(MAX_AT_MENTION_ITEMS),
    "--type",
    "f",
    "--type",
    "d",
    "--follow",
    "--hidden",
    "--exclude",
    ".git",
    "--exclude",
    ".git/*",
    "--exclude",
    ".git/**",
  ];
  if (fdQuery) args.push(fdQuery);

  return await new Promise((resolveItems) => {
    if (signal.aborted) {
      resolveItems([]);
      return;
    }

    const child = spawn(getFdCommand(), args, {
      cwd: baseDir,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    let settled = false;

    const finish = (items: CommandPaletteItem[]) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolveItems(items);
    };

    const onAbort = () => {
      if (child.exitCode === null) child.kill("SIGKILL");
      finish([]);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => finish([]));
    child.on("close", (code) => {
      if (signal.aborted || code !== 0 || !stdout) {
        finish([]);
        return;
      }

      const seen = new Set<string>();
      const items = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => {
          if (line === ".git" || line.startsWith(".git/") || line.includes("/.git/")) return false;
          if (seen.has(line)) return false;
          seen.add(line);
          return true;
        })
        .map((line) => {
          const pathWithoutSlash = line.endsWith("/") ? line.slice(0, -1) : line;
          const displayPath = scoped ? scopedPathForDisplay(scoped.displayBase, pathWithoutSlash) : pathWithoutSlash;
          const absolutePath = resolve(baseDir, pathWithoutSlash);
          const homePath = absolutePath.startsWith(`${homedir()}/`) ? `~/${relative(homedir(), absolutePath)}` : absolutePath;
          const source = line.endsWith("/") ? "dir" : "file";
          const completionPath = source === "dir" ? `${displayPath}/` : displayPath;
          return {
            name: completionPath,
            description: absolutePath,
            source,
            searchText: `${completionPath} ${absolutePath} ${homePath}`,
            insertText: completionPath,
          };
        });
      finish(items);
    });
  });
}

async function getAtMentionPreview(item: CommandPaletteItem, signal: AbortSignal): Promise<string[]> {
  const target = item.description;
  if (!target) return [];

  try {
    const stat = statSync(target);
    if (stat.isDirectory()) {
      const entries = await readdir(target, { withFileTypes: true });
      if (signal.aborted) return [];
      const rows = entries
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .slice(0, MAX_AT_PREVIEW_LINES)
        .map((entry) => `${entry.isDirectory() ? "📁" : "  "} ${entry.name}${entry.isDirectory() ? "/" : ""}`);
      return [target, "", ...rows];
    }

    if (!stat.isFile()) return [target, "", "Not a regular file"];
    const handle = await open(target, "r");
    try {
      const buffer = Buffer.alloc(Math.min(MAX_AT_PREVIEW_BYTES, stat.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (signal.aborted) return [];
      if (buffer.subarray(0, bytesRead).includes(0)) return [target, "", "Binary file"];
      const text = buffer.toString("utf8", 0, bytesRead).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const lines = text.split("\n").slice(0, MAX_AT_PREVIEW_LINES).map((line) => line.replace(/\t/g, "    "));
      if (stat.size > bytesRead || text.split("\n").length > MAX_AT_PREVIEW_LINES) lines.push("…");
      return [target, "", ...lines];
    } finally {
      await handle.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [target, "", `Unable to preview: ${message}`];
  }
}

function getSkillPreviewPath(name: string, cwd: string): string | undefined {
  const candidates = [
    join(homedir(), ".copilot", "skills", name, "SKILL.md"),
    join(homedir(), ".pi", "agent", "skills", name, "SKILL.md"),
    join(homedir(), ".agents", "skills", name, "SKILL.md"),
    join(cwd, ".pi", "skills", name, "SKILL.md"),
  ];
  return candidates.find((path) => existsSync(path));
}

function getSlashCommandPreview(item: CommandPaletteItem, cwd: string): string[] {
  if (item.source !== "skill") {
    return [];
  }

  return [item.previewText ?? item.description ?? "No description"];
}

function formatAtMention(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (/\s/.test(normalized)) return `@"${normalized.replace(/"/g, '\\"')}" `;
  return `@${normalized} `;
}

function getGitInfo(cwd: string): GitInfo {
  const now = Date.now();
  if (gitCache && gitCache.cwd === cwd && now - gitCache.at < GIT_CACHE_MS) return gitCache.info;

  const branch = runGit(cwd, ["branch", "--show-current"]) || null;
  const porcelain = runGit(cwd, ["status", "--short"]);
  const changedFiles = porcelain ? porcelain.split("\n").filter(Boolean).length : 0;
  const numstat = runGit(cwd, ["diff", "--numstat"]);
  let added = 0;
  let removed = 0;

  for (const line of numstat.split("\n")) {
    const [a, r] = line.split("\t");
    const add = Number(a);
    const rem = Number(r);
    if (Number.isFinite(add)) added += add;
    if (Number.isFinite(rem)) removed += rem;
  }

  const modified = Math.min(added, removed);
  const info = { branch, changedFiles, added: added - modified, modified, removed: removed - modified };
  gitCache = { cwd, at: now, info };
  return info;
}

function formatCount(value: number | null | undefined): string {
  if (value == null) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function formatCost(value: number): string {
  if (value === 0) return "$0.000";
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

function compactModelId(modelId: string, maxWidth: number): string {
  if (visibleWidth(modelId) <= maxWidth) return modelId;

  const simplified = modelId
    .replace(/^claude-/, "")
    .replace(/^gpt-/, "")
    .replace(/-20\d{6}$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "");

  if (visibleWidth(simplified) <= maxWidth) return simplified;
  return truncateToWidth(simplified, maxWidth, "…");
}

function compactPath(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}/`)) return `~/${relative(home, cwd)}`;
  return cwd;
}

function isEditorRule(line: string): boolean {
  const plain = stripAnsi(line).trim();
  return plain.includes("─") && [...plain].every((char) => "─↑↓ 0123456789more".includes(char));
}

function sanitizeFooterStatus(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .replace(/^(?:gh):/, "🐙:")
    .replace(/^(?:mcp):/, "🔌:")
    .replace(/^(?:Tavily|web||):/, "🔍:")
    .trim();
}

function splitEditorRender(lines: string[]): { editorLines: string[]; popupLines: string[] } {
  const withoutTop = lines.slice(1);
  const bottomRuleIndex = withoutTop.findIndex(isEditorRule);

  if (bottomRuleIndex === -1) {
    return { editorLines: withoutTop, popupLines: [] };
  }

  return {
    editorLines: withoutTop.slice(0, bottomRuleIndex),
    popupLines: withoutTop.slice(bottomRuleIndex + 1),
  };
}

function getSessionCost(ctx: ExtensionContext): UsageCost {
  let total = 0;
  let hasCost = false;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;

    const cost = entry.message.usage?.cost?.total;
    if (typeof cost !== "number" || !Number.isFinite(cost)) continue;

    total += cost;
    if (cost > 0) hasCost = true;
  }

  const usingSubscription = ctx.model
    ? Boolean((ctx.modelRegistry as { isUsingOAuth?: (model: NonNullable<ExtensionContext["model"]>) => boolean }).isUsingOAuth?.(ctx.model))
    : false;

  return { total, hasCost, usingSubscription };
}

function hideBuiltInWorking(ctx: ExtensionContext): void {
  (ctx.ui as typeof ctx.ui & { setWorkingVisible?: (visible: boolean) => void }).setWorkingVisible?.(false);
}

class HiddenFooter {
  invalidate(): void {}
  dispose(): void {}
  render(): string[] {
    return [];
  }
}

class AmpEditor extends CustomEditor {
  constructor(
    tui: any,
    theme: any,
    keybindings: any,
    private readonly getCtx: () => ExtensionContext,
    private readonly getThinkingLevel: () => string,
    private readonly getWorkingState: () => WorkingState,
    private readonly openCommandPalette: (initialQuery: string | undefined, onSelect: (result: CommandPaletteResult) => void, items?: CommandPaletteItem[] | CommandPaletteItemsProvider, preview?: CommandPalettePreviewProvider, maxRows?: number, noAutoSelect?: boolean) => void,
    private readonly getFooterStatuses: () => string[],
  ) {
    super(tui, theme, keybindings, { paddingX: 1 });
  }

  private get ctx(): ExtensionContext {
    return this.getCtx();
  }

  handleInput(data: string): void {
    if (data === "/" && this.getText().trim() === "") {
      this.openCommandPalette(undefined, (result) => {
        if (result.action === "insert") {
          this.insertCommand(result.command);
        } else {
          this.submitCommand(result.command);
        }
      }, undefined, (item) => getSlashCommandPreview(item, this.ctx.cwd));
      return;
    }

    if (data === "@" && this.isAtMentionPaletteAllowed()) {
      this.openCommandPalette(undefined, (result) => {
        const query = result.query?.trim() ?? "";
        const path = query.startsWith("/") || query.startsWith("~/") ? result.insertText ?? result.command : result.command;
        this.insertTextAtCursor(formatAtMention(path));
        this.tui.requestRender();
      }, (query, signal) => getAtMentionItems(this.ctx.cwd, query, signal), getAtMentionPreview, MAX_AT_MENTION_ITEMS, true);
      return;
    }

    super.handleInput(data);
  }

  private isAtMentionPaletteAllowed(): boolean {
    const cursor = this.getCursor();
    const line = this.getLines()[cursor.line] ?? "";
    const beforeCursor = line.slice(0, cursor.col);
    return beforeCursor.length === 0 || /\s$/.test(beforeCursor);
  }

  private insertCommand(command: string): void {
    this.setText(`/${command} `);
    this.tui.requestRender();
  }

  private submitCommand(command: string): void {
    this.setText(`/${command}`);
    const submitValue = (this as unknown as { submitValue?: () => void }).submitValue;
    if (submitValue) {
      submitValue.call(this);
      return;
    }

    this.onSubmit?.(`/${command}`);
  }

  render(width: number): string[] {
    if (width < 12) return super.render(width);

    const innerWidth = Math.max(1, width - 2);
    const base = super.render(innerWidth);
    const { editorLines, popupLines } = splitEditorRender(base);
    const body = [...editorLines];

    while (body.length < MIN_BODY_LINES) {
      body.push(" ".repeat(innerWidth));
    }

    const leftTop = this.getUsageLabel();
    const rightTop = this.getModelLabel(Math.max(8, Math.floor(innerWidth * 0.48)));
    const cwdLabel = this.getCwdLabel();
    const workingLabel = this.getWorkingLabel();
    const gitChangesLabel = this.getGitChangesLabel();

    return [
      this.borderWithLabels(width, leftTop, rightTop),
      ...body.map((line) => this.wrapBody(line, innerWidth)),
      this.borderWithRightLabel(width, cwdLabel),
      ...this.statusRows(width, workingLabel, gitChangesLabel),
      ...this.wrapPopupBlock(popupLines, width),
    ];
  }

  private getUsageLabel(): string {
    const usage = this.ctx.getContextUsage();
    const pct = usage?.percent == null ? "?" : `${Math.max(0, Math.floor(usage.percent))}%`;
    const contextWindow = usage?.contextWindow ?? this.ctx.model?.contextWindow ?? null;
    const parts = [` ${pct} of ${formatCount(contextWindow)}`];

    const statuses = this.getFooterStatuses();
    if (statuses.length > 0) {
      parts.push(statuses.join(this.fg("dim", " · ")));
    }

    return `${parts.join(" · ")} `;
  }

  private getModelLabel(maxWidth: number): string {
    const modelId = this.ctx.model?.id ?? "model unknown";
    const thinkingLevel = this.getThinkingLevel();
    const thinkingWidth = visibleWidth(thinkingLevel);
    const modelWidth = Math.max(1, maxWidth - thinkingWidth - 3);
    const model = this.fg("text", compactModelId(modelId, modelWidth));
    const thinking = this.fg(this.getThinkingColor(), thinkingLevel);
    return ` ${model} ${this.fg("dim", "·")} ${thinking} `;
  }

  private getThinkingColor(): ThemeColor {
    switch (this.getThinkingLevel()) {
      case "minimal":
        return "thinkingMinimal";
      case "low":
        return "thinkingLow";
      case "medium":
        return "thinkingMedium";
      case "high":
        return "thinkingHigh";
      case "xhigh":
        return "thinkingXhigh";
      case "off":
      default:
        return "thinkingOff";
    }
  }

  private getCwdLabel(): string {
    const git = getGitInfo(this.ctx.cwd);
    const sessionName = this.ctx.sessionManager.getSessionName?.();
    const cwd = `${compactPath(this.ctx.cwd)}${git.branch ? ` (${git.branch})` : ""}`;
    return ` ${sessionName ? `${sessionName} · ` : ""}${cwd} `;
  }

  private getWorkingLabel(): string {
    const working = this.getWorkingState();
    if (!working.active) return "";
    const sep = this.fg("dim", " · ");
    const hints = [
      `${this.fg("accent", "Esc")} ${this.fg("dim", "cancel")}`,
      `${this.fg("accent", "Enter")} ${this.fg("dim", "steer")}`,
      `${this.fg("accent", "Alt+Enter")} ${this.fg("dim", "queue")}`,
    ].join(sep);
    return `${this.fg("muted", working.emoji)} ${this.fg("muted", working.message)}${this.fg("dim", working.frame)}  ${hints}`;
  }

  private getGitChangesLabel(): string {
    const git = getGitInfo(this.ctx.cwd);
    if (git.changedFiles === 0) return "";

    const fileLabel = this.fg("muted", `${git.changedFiles} ${git.changedFiles === 1 ? "file" : "files"} changed`);
    const added = git.added > 0 ? ` ${this.fg("toolDiffAdded", `+${git.added}`)}` : "";
    const modified = git.modified > 0 ? ` ${this.fg("warning", `~${git.modified}`)}` : "";
    const removed = git.removed > 0 ? ` ${this.fg("toolDiffRemoved", `-${git.removed}`)}` : "";
    return `${fileLabel}${added}${modified}${removed}`;
  }

  private fg(color: ThemeColor, text: string): string {
    return this.ctx.ui.theme.fg(color, text);
  }

  private wrapBody(line: string, innerWidth: number): string {
    const clipped = truncateToWidth(line, innerWidth, "");
    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
    const content = clipped ? this.fg("text", clipped) : clipped;
    return this.sideBorder() + content + padding + this.sideBorder();
  }


  private wrapPopupBlock(lines: string[], width: number): string[] {
    if (lines.length === 0) return [];

    return lines.map((line) => {
      const clipped = truncateToWidth(line, width, "");
      const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
      return clipped + padding;
    });
  }

  private statusRows(width: number, leftLabel: string, rightLabel: string): string[] {
    if (!leftLabel && !rightLabel) return [];

    const contentWidth = Math.max(1, width - STATUS_LEFT_INSET - STATUS_RIGHT_INSET);
    const maxLeft = Math.max(0, Math.floor(contentWidth * 0.44));
    const maxRight = Math.max(0, contentWidth - maxLeft - 2);
    const left = truncateToWidth(leftLabel, maxLeft, "…");
    const right = truncateToWidth(rightLabel, maxRight, "…");
    const gap = " ".repeat(Math.max(1, contentWidth - visibleWidth(left) - visibleWidth(right)));
    const leftPadding = " ".repeat(Math.min(STATUS_LEFT_INSET, Math.max(0, width - contentWidth)));
    const rightPadding = " ".repeat(Math.min(STATUS_RIGHT_INSET, Math.max(0, width - contentWidth - visibleWidth(leftPadding))));
    return [`${leftPadding}${left}${gap}${right}${rightPadding}`, ""];
  }

  private borderWithLabels(width: number, leftLabel: string, rightLabel: string): string {
    const innerWidth = Math.max(0, width - 2);
    const maxLeft = Math.max(0, Math.floor(innerWidth * 0.44));
    const maxRight = Math.max(0, innerWidth - maxLeft - 2);
    const left = this.fg("muted", truncateToWidth(leftLabel, maxLeft, "…"));
    const right = truncateToWidth(rightLabel, maxRight, "…");
    const used = visibleWidth(left) + visibleWidth(right);
    const fill = Math.max(0, innerWidth - used);
    return this.borderColor("╭") + left + this.borderColor("─".repeat(fill)) + right + this.borderColor("╮");
  }

  private sideBorder(): string {
    return this.borderColor("│");
  }

  private borderWithRightLabel(width: number, label: string): string {
    const innerWidth = Math.max(0, width - 2);
    const right = this.fg("muted", truncateToWidth(label, Math.max(0, innerWidth - 2), "…"));
    const fill = Math.max(0, innerWidth - visibleWidth(right));
    return this.borderColor("╰") + this.borderColor("─".repeat(fill)) + right + this.borderColor("╯");
  }
}

function formatSourcePath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~/${relative(home, path)}`;
  return path;
}

function getCommandPaletteItems(pi: ExtensionAPI): CommandPaletteItem[] {
  const items = [
    ...BUILTIN_COMMAND_PALETTE_ITEMS,
    ...pi.getCommands().map((command) => {
      const sourcePath = formatSourcePath(command.sourceInfo?.path);
      return {
        name: command.name,
        description: sourcePath ?? command.description,
        source: command.source,
        searchText: undefined,
        previewText: command.description,
      };
    }),
  ];
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
}

export default function (pi: ExtensionAPI) {
  const activeToolExecutions = new Set<string>();
  let activeThinkingLevel = "off";
  let activeCtx: ExtensionContext | undefined;
  let activeTui: { requestRender(): void } | undefined;
  let activeFooterData: { getExtensionStatuses(): ReadonlyMap<string, string> } | undefined;
  let commandPaletteOpen = false;
  let isWorking = false;
  let workingMessage = "";
  let workingFrameIndex = 0;
  let workingTimer: ReturnType<typeof setInterval> | undefined;

  const requestRender = () => activeTui?.requestRender();
  const footerStatusOrder = new Map([
    ["copilot-usage", 0],
    ["mcp", 1],
    ["tavily-usage", 2],
  ]);

  const getFooterStatuses = () => Array.from(activeFooterData?.getExtensionStatuses().entries() ?? [])
    .sort(([a], [b]) => (footerStatusOrder.get(a) ?? 100) - (footerStatusOrder.get(b) ?? 100) || a.localeCompare(b))
    .map(([, text]) => sanitizeFooterStatus(text))
    .filter(Boolean);

  const stopWorkingTimer = () => {
    if (!workingTimer) return;
    clearInterval(workingTimer);
    workingTimer = undefined;
  };

  const startWorkingTimer = () => {
    stopWorkingTimer();
    workingTimer = setInterval(() => {
      workingFrameIndex = (workingFrameIndex + 1) % WORKING_FRAMES.length;
      requestRender();
    }, 300);
  };

  let workingEmoji = "";
  const pickWorkingMessage = (): string => {
    workingEmoji = WORKING_EMOJIS[Math.floor(Math.random() * WORKING_EMOJIS.length)];
    return WORKING_MESSAGES[Math.floor(Math.random() * WORKING_MESSAGES.length)];
  };

  const setWorkingMessage = (message: string, ctx?: ExtensionContext) => {
    workingMessage = message;
    ctx?.ui.setWorkingMessage(message);
    requestRender();
  };

  const openCommandPalette = (initialQuery = "", onSelect: (result: CommandPaletteResult) => void, items?: CommandPaletteItem[] | CommandPaletteItemsProvider, preview?: CommandPalettePreviewProvider, maxRows?: number, noAutoSelect = false) => {
    const ctx = activeCtx;
    if (!ctx?.hasUI || commandPaletteOpen) return;

    commandPaletteOpen = true;
    void ctx.ui.custom<CommandPaletteResult | null>(
      (tui, theme, keybindings, done) => new CommandPaletteOverlay(
        typeof items === "function" ? [] : items ?? getCommandPaletteItems(pi),
        initialQuery,
        tui,
        theme,
        keybindings,
        done,
        typeof items === "function" ? items : undefined,
        preview,
        maxRows,
        noAutoSelect,
      ),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "90%",
          minWidth: 42,
          maxHeight: "80%",
          margin: 1,
        },
      },
    ).then((result) => {
      commandPaletteOpen = false;
      if (!result) return;
      onSelect(result);
    }).catch(() => {
      commandPaletteOpen = false;
    });
  };

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    activeCtx = ctx;
    activeThinkingLevel = pi.getThinkingLevel();

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      activeTui = tui;
      return new AmpEditor(tui, theme, keybindings, () => activeCtx ?? ctx, () => activeThinkingLevel, () => ({
        active: isWorking,
        message: workingMessage,
        frame: WORKING_FRAMES[workingFrameIndex] ?? WORKING_FRAMES[0],
        emoji: workingEmoji,
      }), openCommandPalette, getFooterStatuses);
    });

    hideBuiltInWorking(ctx);

    ctx.ui.setFooter((_tui, _theme, footerData) => {
      activeFooterData = footerData;
      return new HiddenFooter();
    });
  });

  pi.on("thinking_level_select", (event, ctx) => {
    activeThinkingLevel = event.level;
    if (ctx.hasUI) requestRender();
  });

  pi.on("before_agent_start", (_event, ctx) => {
    activeThinkingLevel = pi.getThinkingLevel();
    activeToolExecutions.clear();
    isWorking = true;
    workingFrameIndex = 0;
    startWorkingTimer();
    if (!ctx.hasUI) return;
    hideBuiltInWorking(ctx);
    setWorkingMessage(pickWorkingMessage(), ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    hideBuiltInWorking(ctx);
  });

  pi.on("message_update", (event, ctx) => {
    if (!ctx.hasUI || event.message.role !== "assistant") return;
    if (activeToolExecutions.size > 0) return;
    setWorkingMessage(pickWorkingMessage(), ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    activeToolExecutions.add(event.toolCallId);
    if (!ctx.hasUI) return;
    setWorkingMessage(pickWorkingMessage(), ctx);
  });

  pi.on("tool_execution_update", (_event, ctx) => {
    if (!ctx.hasUI) return;
    setWorkingMessage(pickWorkingMessage(), ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    activeToolExecutions.delete(event.toolCallId);
    if (!ctx.hasUI) return;
    if (activeToolExecutions.size === 0) {
      setWorkingMessage(pickWorkingMessage(), ctx);
    }
  });

  pi.on("agent_end", (_event, _ctx) => {
    isWorking = false;
    activeToolExecutions.clear();
    stopWorkingTimer();
    requestRender();
  });

  pi.on("session_shutdown", () => {
    stopWorkingTimer();
    activeTui = undefined;
  });
}
