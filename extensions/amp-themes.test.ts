import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const requiredColorTokens = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "selectedBg",
  "userMessageBg",
  "userMessageText",
  "customMessageBg",
  "customMessageText",
  "customMessageLabel",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode",
];

type ThemeFile = {
  name: string;
  vars?: Record<string, string | number>;
  colors: Record<string, string | number>;
};

function readTheme(fileName: string): ThemeFile {
  return JSON.parse(readFileSync(join(process.cwd(), "themes", fileName), "utf8")) as ThemeFile;
}

test.each([
  ["amp-dark.json", "amp-dark"],
  ["amp-light.json", "amp-light"],
  ["amp-gruvbox-dark-hard.json", "amp-gruvbox-dark-hard"],
])("%s defines every required Pi color token", (fileName, expectedName) => {
  const theme = readTheme(fileName);

  expect(theme.name).toBe(expectedName);
  expect(Object.keys(theme.colors).sort()).toEqual([...requiredColorTokens].sort());

  for (const [token, value] of Object.entries(theme.colors)) {
    expect(value, `${fileName}:${token}`).not.toBe("");
  }
});

test("amp-gruvbox-dark-hard uses the canonical Gruvbox dark hard palette", () => {
  const theme = readTheme("amp-gruvbox-dark-hard.json");

  expect(theme.vars).toEqual({
    "gruvbox-bg0-hard": "#1d2021",
    "gruvbox-bg0": "#282828",
    "gruvbox-bg0-soft": "#32302f",
    "gruvbox-bg1": "#3c3836",
    "gruvbox-bg2": "#504945",
    "gruvbox-bg3": "#665c54",
    "gruvbox-bg4": "#7c6f64",
    "gruvbox-gray": "#928374",
    "gruvbox-fg0-hard": "#f9f5d7",
    "gruvbox-fg0": "#fbf1c7",
    "gruvbox-fg0-soft": "#f2e5bc",
    "gruvbox-fg1": "#ebdbb2",
    "gruvbox-fg2": "#d5c4a1",
    "gruvbox-fg3": "#bdae93",
    "gruvbox-fg4": "#a89984",
    "gruvbox-red": "#fb4934",
    "gruvbox-green": "#b8bb26",
    "gruvbox-yellow": "#fabd2f",
    "gruvbox-blue": "#83a598",
    "gruvbox-purple": "#d3869b",
    "gruvbox-aqua": "#8ec07c",
    "gruvbox-orange": "#fe8019",
    "gruvbox-neutral-red": "#cc241d",
    "gruvbox-neutral-green": "#98971a",
    "gruvbox-neutral-yellow": "#d79921",
    "gruvbox-neutral-blue": "#458588",
    "gruvbox-neutral-purple": "#b16286",
    "gruvbox-neutral-aqua": "#689d6a",
    "gruvbox-neutral-orange": "#d65d0e",
  });
});

test("amp-gruvbox-dark-hard maps Pi tokens to Gruvbox roles", () => {
  const theme = readTheme("amp-gruvbox-dark-hard.json");

  expect(theme.colors).toMatchObject({
    accent: "gruvbox-green",
    border: "gruvbox-bg4",
    borderAccent: "gruvbox-green",
    borderMuted: "gruvbox-bg3",
    text: "gruvbox-fg1",
    thinkingText: "gruvbox-fg3",
    muted: "gruvbox-fg4",
    dim: "gruvbox-gray",
    selectedBg: "gruvbox-bg1",
    error: "gruvbox-red",
    warning: "gruvbox-orange",
    success: "gruvbox-green",
    syntaxComment: "gruvbox-gray",
    syntaxKeyword: "gruvbox-red",
    syntaxFunction: "gruvbox-green",
    syntaxVariable: "gruvbox-blue",
    syntaxString: "gruvbox-green",
    syntaxNumber: "gruvbox-purple",
    syntaxType: "gruvbox-yellow",
    syntaxOperator: "gruvbox-fg1",
    syntaxPunctuation: "gruvbox-fg4",
    thinkingOff: "gruvbox-bg3",
    thinkingMinimal: "gruvbox-fg4",
    thinkingLow: "gruvbox-green",
    thinkingMedium: "gruvbox-yellow",
    thinkingHigh: "gruvbox-orange",
    thinkingXhigh: "gruvbox-red",
    bashMode: "gruvbox-orange",
  });
});
