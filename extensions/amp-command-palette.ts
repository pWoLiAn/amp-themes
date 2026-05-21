import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, fuzzyFilter, Key, type KeybindingsManager, matchesKey, parseKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const MIN_WIDTH = 40;
const DEFAULT_MAX_ROWS = 15;
const PREVIEW_ROWS = 10;
const SIDE_PADDING = 1;
const TITLE = " Command Palette ";
const HELP_HINT = " type filter · ↑↓ navigate · tab complete/insert · enter run/insert · esc close ";

export interface CommandPaletteItem {
  name: string;
  description?: string;
  source?: string;
  searchText?: string;
  insertText?: string;
  previewText?: string;
}

export interface CommandPaletteResult {
  command: string;
  action: "insert" | "submit";
  query?: string;
  insertText?: string;
}

export type CommandPaletteItemsProvider = (query: string, signal: AbortSignal) => CommandPaletteItem[] | Promise<CommandPaletteItem[]>;
export type CommandPalettePreviewProvider = (item: CommandPaletteItem, signal: AbortSignal) => string[] | Promise<string[]>;

export const BUILTIN_COMMAND_PALETTE_ITEMS: CommandPaletteItem[] = [
  { name: "settings", description: "Open settings menu", source: "builtin" },
  { name: "model", description: "Select model", source: "builtin" },
  { name: "scoped-models", description: "Enable/disable Ctrl+P model cycling", source: "builtin" },
  { name: "export", description: "Export session", source: "builtin" },
  { name: "import", description: "Import and resume a session", source: "builtin" },
  { name: "share", description: "Share session as a secret GitHub gist", source: "builtin" },
  { name: "copy", description: "Copy last agent message to clipboard", source: "builtin" },
  { name: "name", description: "Set session display name", source: "builtin" },
  { name: "session", description: "Show session info and stats", source: "builtin" },
  { name: "changelog", description: "Show changelog entries", source: "builtin" },
  { name: "hotkeys", description: "Show all keyboard shortcuts", source: "builtin" },
  { name: "fork", description: "Create a new fork", source: "builtin" },
  { name: "clone", description: "Duplicate current session", source: "builtin" },
  { name: "tree", description: "Navigate session tree", source: "builtin" },
  { name: "login", description: "Configure provider authentication", source: "builtin" },
  { name: "logout", description: "Remove provider authentication", source: "builtin" },
  { name: "new", description: "Start a new session", source: "builtin" },
  { name: "compact", description: "Manually compact context", source: "builtin" },
  { name: "resume", description: "Resume a different session", source: "builtin" },
  { name: "render", description: "Render the last N session messages, or all messages with /render all", source: "builtin" },
  { name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes", source: "builtin" },
  { name: "quit", description: "Quit Pi", source: "builtin" },
];

type StyleText = (color: ThemeColor, text: string) => string;

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function normalizeToSingleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export class CommandPaletteOverlay implements Component {
  private query: string;
  private selectedIndex = 0;
  private scrollOffset = 0;
  private hasSelection = false;
  private asyncItems: CommandPaletteItem[] | null = null;
  private asyncLoading = false;
  private asyncRequestId = 0;
  private asyncDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private asyncAbort: AbortController | undefined;
  private previewKey = "";
  private previewLines: string[] = [];
  private previewLoading = false;
  private previewRequestId = 0;
  private previewDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private previewAbort: AbortController | undefined;

  constructor(
    private readonly items: CommandPaletteItem[],
    initialQuery: string,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (result: CommandPaletteResult | null) => void,
    private readonly itemProvider?: CommandPaletteItemsProvider,
    private readonly previewProvider?: CommandPalettePreviewProvider,
    private readonly maxRows = DEFAULT_MAX_ROWS,
    private readonly noAutoSelect = false,
    private readonly inputPrefix = "/",
  ) {
    this.query = initialQuery.replace(/^\//, "");
    this.scheduleItemLoad(0);
  }

  invalidate(): void {}

  private finish(result: CommandPaletteResult | null): void {
    if (this.asyncDebounceTimer) {
      clearTimeout(this.asyncDebounceTimer);
      this.asyncDebounceTimer = undefined;
    }
    this.asyncAbort?.abort();
    this.asyncAbort = undefined;
    if (this.previewDebounceTimer) {
      clearTimeout(this.previewDebounceTimer);
      this.previewDebounceTimer = undefined;
    }
    this.previewAbort?.abort();
    this.previewAbort = undefined;
    this.done(result);
  }

  handleInput(data: string): void {
    const filtered = this.getFilteredItems();

    if (this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
      this.finish(null);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.up")) {
      this.hasSelection = true;
      this.selectedIndex = filtered.length === 0 ? 0 : Math.max(0, this.selectedIndex - 1);
      this.ensureSelectionVisible();
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.down")) {
      this.hasSelection = true;
      this.selectedIndex = filtered.length === 0 ? 0 : Math.min(filtered.length - 1, this.selectedIndex + 1);
      this.ensureSelectionVisible();
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.hasSelection = true;
      this.selectedIndex = Math.max(0, this.selectedIndex - this.maxRows);
      this.ensureSelectionVisible();
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.hasSelection = true;
      this.selectedIndex = filtered.length === 0 ? 0 : Math.min(filtered.length - 1, this.selectedIndex + this.maxRows);
      this.ensureSelectionVisible();
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.input.tab") || matchesKey(data, Key.tab)) {
      if (this.noAutoSelect && !this.hasSelection) {
        // First tab: just select item 0, don't complete yet
        if (filtered.length > 0) {
          this.hasSelection = true;
          this.selectedIndex = 0;
          this.tui.requestRender();
        }
        return;
      }
      const selected = filtered[this.selectedIndex];
      if (selected && this.itemProvider) {
        this.query = selected.insertText ?? selected.name;
        this.selectedIndex = 0;
        this.scrollOffset = 0;
        this.hasSelection = false;
        this.scheduleItemLoad(0);
        this.tui.requestRender();
      } else {
        this.finish(selected ? this.resultForItem(selected, "insert") : null);
      }
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (this.noAutoSelect && !this.hasSelection) {
        // No item selected — insert the raw query text
        this.finish(this.query.length > 0 ? { command: this.query, action: "insert", query: this.query, insertText: this.query } : null);
      } else {
        const selected = filtered[this.selectedIndex];
        this.finish(selected ? this.resultForItem(selected, "insert") : null);
      }
      return;
    }

    if (isClearQueryKey(data, this.keybindings)) {
      this.query = "";
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      this.scheduleItemLoad();
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, Key.backspace)) {
      if (this.query.length === 0) {
        this.finish(null);
        return;
      }

      this.query = this.query.slice(0, -1);
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      this.hasSelection = false;
      this.scheduleItemLoad();
      this.tui.requestRender();
      return;
    }

    const printable = getPrintableInput(data);
    if (printable) {
      this.query += printable;
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      this.hasSelection = false;
      this.scheduleItemLoad();
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const boxWidth = Math.max(MIN_WIDTH, width);
    const innerWidth = Math.max(1, boxWidth - 2);
    const contentWidth = Math.max(1, innerWidth - SIDE_PADDING * 2);
    const filtered = this.getFilteredItems();
    this.selectedIndex = filtered.length === 0 ? 0 : Math.min(this.selectedIndex, filtered.length - 1);
    this.ensureSelectionVisible();

    const isSelected = !this.noAutoSelect || this.hasSelection;
    const selectedItem = isSelected ? filtered[this.selectedIndex] : undefined;
    this.schedulePreviewLoad(selectedItem);

    const visibleItems = filtered.slice(this.scrollOffset, this.scrollOffset + this.maxRows);
    const renderRows = (rowWidth: number) => visibleItems.length > 0
      ? visibleItems.map((item, index) => this.renderItem(item, isSelected && this.scrollOffset + index === this.selectedIndex, rowWidth))
      : [this.fg(this.asyncLoading ? "muted" : "warning", this.asyncLoading ? "Loading..." : "No commands match")];

    const rows = padRows(renderRows(contentWidth), this.maxRows);
    const previewRows = this.previewProvider ? padRows(this.renderPreview(contentWidth), PREVIEW_ROWS + 1) : [];

    return [
      topBorder(boxWidth, this.theme),
      wrapContent(this.renderInput(contentWidth), boxWidth, this.theme),
      wrapContent("", boxWidth, this.theme),
      ...rows.map((row) => wrapContent(row, boxWidth, this.theme)),
      ...previewRows.map((row) => wrapContent(row, boxWidth, this.theme)),
      wrapContent(this.renderCount(filtered.length, contentWidth), boxWidth, this.theme),
      bottomBorder(boxWidth, this.theme),
    ];
  }

  private ensureSelectionVisible(): void {
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
      return;
    }

    const lastVisibleIndex = this.scrollOffset + this.maxRows - 1;
    if (this.selectedIndex > lastVisibleIndex) {
      this.scrollOffset = this.selectedIndex - this.maxRows + 1;
    }
  }

  private getFilteredItems(): CommandPaletteItem[] {
    const sourceItems = this.itemProvider ? this.asyncItems ?? [] : this.items;
    const deduped = dedupeItems(sourceItems);
    if (!this.query.trim()) return deduped;
    return fuzzyFilter(deduped, this.query, (item) => [item.name, item.description, item.source, item.searchText]
      .filter((value): value is string => value !== undefined)
      .map(normalizeToSingleLine)
      .join(" "));
  }

  private scheduleItemLoad(delayMs = 80): void {
    if (!this.itemProvider) return;
    if (this.asyncDebounceTimer) clearTimeout(this.asyncDebounceTimer);
    this.asyncDebounceTimer = setTimeout(() => {
      this.asyncDebounceTimer = undefined;
      void this.loadItemsNow();
    }, delayMs);
  }

  private async loadItemsNow(): Promise<void> {
    if (!this.itemProvider) return;
    const requestId = ++this.asyncRequestId;
    this.asyncAbort?.abort();
    const controller = new AbortController();
    this.asyncAbort = controller;
    this.asyncLoading = true;
    this.tui.requestRender();

    try {
      const items = await this.itemProvider(this.query, controller.signal);
      if (controller.signal.aborted || requestId !== this.asyncRequestId) return;
      this.asyncItems = items;
      this.asyncLoading = false;
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      this.previewKey = "";
      this.tui.requestRender();
    } catch {
      if (controller.signal.aborted || requestId !== this.asyncRequestId) return;
      this.asyncItems = [];
      this.asyncLoading = false;
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      this.previewKey = "";
      this.tui.requestRender();
    }
  }

  private schedulePreviewLoad(item: CommandPaletteItem | undefined): void {
    if (!this.previewProvider || !item) {
      this.previewKey = "";
      this.previewLines = [];
      this.previewLoading = false;
      return;
    }

    const key = `${item.source ?? ""}:${item.insertText ?? item.name}:${item.description ?? ""}`;
    if (key === this.previewKey) return;

    this.previewKey = key;
    this.previewLines = [];
    this.previewLoading = true;
    this.previewAbort?.abort();
    if (this.previewDebounceTimer) clearTimeout(this.previewDebounceTimer);
    this.previewDebounceTimer = setTimeout(() => {
      this.previewDebounceTimer = undefined;
      void this.loadPreviewNow(item, key);
    }, 50);
  }

  private async loadPreviewNow(item: CommandPaletteItem, key: string): Promise<void> {
    if (!this.previewProvider) return;
    const requestId = ++this.previewRequestId;
    const controller = new AbortController();
    this.previewAbort = controller;

    try {
      const lines = await this.previewProvider(item, controller.signal);
      if (controller.signal.aborted || requestId !== this.previewRequestId || key !== this.previewKey) return;
      this.previewLines = lines.slice(0, PREVIEW_ROWS);
      this.previewLoading = false;
      this.tui.requestRender();
    } catch {
      if (controller.signal.aborted || requestId !== this.previewRequestId || key !== this.previewKey) return;
      this.previewLines = ["Unable to preview"];
      this.previewLoading = false;
      this.tui.requestRender();
    }
  }

  private renderPreview(width: number): string[] {
    if (!this.previewProvider || !this.previewKey) return [];
    const label = this.fg("dim", "Preview");
    const lines = this.previewLoading && this.previewLines.length === 0 ? [this.fg("muted", "Loading preview...")] : this.previewLines;
    return [
      label,
      ...wrapPreviewLines(lines, width, PREVIEW_ROWS),
    ];
  }


  private resultForItem(item: CommandPaletteItem, action: CommandPaletteResult["action"]): CommandPaletteResult {
    return {
      command: item.name,
      action,
      query: this.query,
      insertText: item.insertText,
    };
  }

  private renderInput(width: number): string {
    const prompt = this.fg("dim", "> ") + this.fg("accent", this.inputPrefix);
    const text = this.fg("text", this.query);
    return truncateToWidth(prompt + text, width, "…", false);
  }

  private renderItem(item: CommandPaletteItem, selected: boolean, width: number): string {
    const sourceWidth = 12;
    const descriptionWidth = Math.max(0, Math.floor(width * 0.45));
    const nameWidth = Math.max(8, width - sourceWidth - descriptionWidth - 4);
    const marker = selected ? this.fg("accent", "→ ") : "  ";
    const sourceText = item.source ? normalizeToSingleLine(item.source) : "";
    const nameText = normalizeToSingleLine(item.name);
    const descriptionText = item.description ? normalizeToSingleLine(item.description) : "";
    const source = sourceText ? this.fg("muted", truncateToWidth(sourceText, sourceWidth, "…")) : "";
    const nameColor: ThemeColor = selected ? "accent" : "text";
    const name = this.fg(nameColor, truncateToWidth(nameText, nameWidth, "…"));
    const description = descriptionText ? this.fg(selected ? "text" : "muted", truncateToWidth(descriptionText, descriptionWidth, "…")) : "";
    const left = padVisible(`${marker}${source}`, sourceWidth + 2);
    const middle = padVisible(name, nameWidth + 2);
    return truncateToWidth(`${left}${middle}${description}`, width, "", false);
  }

  private renderCount(total: number, width: number): string {
    const shown = Math.min(total, this.maxRows);
    const text = total > this.maxRows ? `(${shown}/${total})` : `(${total})`;
    return truncateToWidth(this.fg("dim", text), width, "");
  }

  private fg(color: ThemeColor, text: string): string {
    return this.theme.fg(color, text);
  }
}

function getDefaultCommandAction(_item: CommandPaletteItem): CommandPaletteResult["action"] {
  return "insert";
}

function dedupeItems(items: CommandPaletteItem[]): CommandPaletteItem[] {
  const seen = new Set<string>();
  const result: CommandPaletteItem[] = [];
  for (const item of items) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    result.push(item);
  }
  return result;
}

function isClearQueryKey(data: string, keybindings: KeybindingsManager): boolean {
  const parsed = parseKey(data);
  return (
    data === "\x15" ||
    keybindings.matches(data, "tui.editor.deleteToLineStart") ||
    matchesKey(data, Key.ctrl("u")) ||
    matchesKey(data, Key.super("backspace")) ||
    matchesKey(data, Key.super("delete")) ||
    parsed === "super+backspace" ||
    parsed === "super+delete" ||
    parsed === "ctrl+backspace" ||
    parsed === "ctrl+delete"
  );
}

function getPrintableInput(data: string): string {
  if (data.length === 1 && data >= " " && data !== "\x7f") return data;
  return "";
}

function topBorder(width: number, theme: Theme): string {
  const innerWidth = Math.max(0, width - 2);
  const titleWidth = visibleWidth(TITLE);
  if (innerWidth < titleWidth + 2) return theme.fg("accent", `╭${"─".repeat(innerWidth)}╮`);

  const leftFill = Math.max(1, Math.floor((innerWidth - titleWidth) / 2));
  const rightFill = Math.max(0, innerWidth - titleWidth - leftFill);
  const title = theme.fg("accent", theme.bold(TITLE));
  return theme.fg("accent", `╭${"─".repeat(leftFill)}`) + title + theme.fg("accent", `${"─".repeat(rightFill)}╮`);
}

function bottomBorder(width: number, theme: Theme): string {
  const innerWidth = Math.max(0, width - 2);
  if (innerWidth < visibleWidth(HELP_HINT) + 2) return theme.fg("accent", `╰${"─".repeat(innerWidth)}╯`);

  const label = theme.fg("dim", HELP_HINT);
  const fill = Math.max(0, innerWidth - visibleWidth(HELP_HINT) - 1);
  return theme.fg("accent", "╰") + theme.fg("accent", "─".repeat(fill)) + label + theme.fg("accent", "─╯");
}

function wrapContent(line: string, width: number, theme: Theme): string {
  const innerWidth = Math.max(1, width - 2 - SIDE_PADDING * 2);
  const clipped = truncateToWidth(line, innerWidth, "", false);
  return theme.fg("accent", "│") + " ".repeat(SIDE_PADDING) + padVisible(clipped, innerWidth) + " ".repeat(SIDE_PADDING) + theme.fg("accent", "│");
}

function padVisible(line: string, width: number): string {
  return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

function padRows(rows: string[], height: number): string[] {
  if (rows.length >= height) return rows.slice(0, height);
  return [...rows, ...Array.from({ length: height - rows.length }, () => "")];
}

function wrapPreviewLines(lines: string[], width: number, maxRows: number): string[] {
  const rows: string[] = [];
  for (const line of lines) {
    const normalized = line.length === 0 ? " " : line;
    let rest = normalized;
    while (visibleWidth(rest) > width && rows.length < maxRows) {
      const chunk = truncateToWidth(rest, width, "", false);
      rows.push(chunk);
      rest = rest.slice(chunk.length).trimStart();
    }
    if (rows.length >= maxRows) break;
    rows.push(rest);
    if (rows.length >= maxRows) break;
  }
  return rows.slice(0, maxRows);
}
