import { CustomEditor, type ExtensionAPI, type ExtensionContext, type ThemeColor } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { relative } from "node:path";

const MIN_BODY_LINES = 2;
const GIT_CACHE_MS = 2000;

type GitInfo = {
  branch: string | null;
  changedFiles: number;
  added: number;
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

  const info = { branch, changedFiles, added, removed };
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

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function isEditorRule(line: string): boolean {
  const plain = stripAnsi(line).trim();
  return plain.includes("─") && [...plain].every((char) => "─↑↓ 0123456789more".includes(char));
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

class AmpEditor extends CustomEditor {
  constructor(
    tui: any,
    theme: any,
    keybindings: any,
    private readonly ctx: ExtensionContext,
    private readonly getThinkingLevel: () => string,
  ) {
    super(tui, theme, keybindings, { paddingX: 1 });
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

    return [
      this.borderWithLabels(width, leftTop, rightTop),
      ...body.map((line) => this.wrapBody(line, innerWidth)),
      this.borderWithRightLabel(width, cwdLabel),
      ...this.wrapPopupBlock(popupLines, width),
    ];
  }

  private getUsageLabel(): string {
    const usage = this.ctx.getContextUsage();
    const pct = usage?.percent == null ? "?" : `${Math.max(0, Math.floor(usage.percent))}%`;
    const contextWindow = usage?.contextWindow ?? this.ctx.model?.contextWindow ?? null;
    const parts = [` ${pct} of ${formatCount(contextWindow)}`];

    const cost = getSessionCost(this.ctx);
    if (cost.hasCost || cost.usingSubscription) {
      parts.push(`${formatCost(cost.total)}${cost.usingSubscription ? " (sub)" : ""}`);
    }

    return `${parts.join(" · ")} `;
  }

  private getModelLabel(maxWidth: number): string {
    const modelId = this.ctx.model?.id ?? "model unknown";
    const thinkingLevel = this.getThinkingLevel();
    const thinkingWidth = visibleWidth(thinkingLevel);
    const modelWidth = Math.max(1, maxWidth - thinkingWidth - 3);
    return ` ${compactModelId(modelId, modelWidth)} · ${thinkingLevel} `;
  }

  private getCwdLabel(): string {
    const git = getGitInfo(this.ctx.cwd);
    const gitLabel = git.changedFiles > 0
      ? ` · ${git.changedFiles} ${git.changedFiles === 1 ? "file" : "files"} changed +${git.added} -${git.removed}`
      : "";
    return ` ${compactPath(this.ctx.cwd)}${git.branch ? ` (${git.branch})` : ""}${gitLabel} `;
  }

  private fg(color: ThemeColor, text: string): string {
    return this.ctx.ui.theme.fg(color, text);
  }

  private wrapBody(line: string, innerWidth: number): string {
    const clipped = truncateToWidth(line, innerWidth, "");
    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
    return this.fg("borderMuted", "│") + clipped + padding + this.fg("borderMuted", "│");
  }

  private wrapPopupBlock(lines: string[], width: number): string[] {
    if (lines.length === 0) return [];

    const indent = "    ";
    const contentWidth = Math.max(1, width - visibleWidth(indent));

    return lines.map((line) => {
      const clipped = truncateToWidth(line, contentWidth, "");
      const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
      return indent + clipped + padding;
    });
  }

  private borderWithLabels(width: number, leftLabel: string, rightLabel: string): string {
    const innerWidth = Math.max(0, width - 2);
    const maxLeft = Math.max(0, Math.floor(innerWidth * 0.44));
    const maxRight = Math.max(0, innerWidth - maxLeft - 2);
    const left = this.fg("muted", truncateToWidth(leftLabel, maxLeft, "…"));
    const right = this.fg("thinkingText", truncateToWidth(rightLabel, maxRight, "…"));
    const used = visibleWidth(left) + visibleWidth(right);
    const fill = Math.max(0, innerWidth - used);
    return this.fg("borderMuted", "╭") + left + this.fg("border", "─".repeat(fill)) + right + this.fg("borderMuted", "╮");
  }

  private borderWithRightLabel(width: number, label: string): string {
    const innerWidth = Math.max(0, width - 2);
    const right = this.fg("muted", truncateToWidth(label, Math.max(0, innerWidth - 2), "…"));
    const fill = Math.max(0, innerWidth - visibleWidth(right));
    return this.fg("borderMuted", "╰") + this.fg("borderMuted", "─".repeat(fill)) + right + this.fg("borderMuted", "╯");
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new AmpEditor(tui, theme, keybindings, ctx, () =>
        typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : "off",
      ),
    );

    ctx.ui.setWorkingIndicator({
      frames: [ctx.ui.theme.fg("accent", "∴")],
    });
    ctx.ui.setWorkingMessage("Working...");

    ctx.ui.setFooter(() => ({
      invalidate() {},
      render() {
        return [];
      },
    }));
  });
}
