/**
 * pi-render-md
 *
 * Problem
 * - Depending on the model, assistant responses are sometimes wrapped in
 *   ```markdown fences. In pi's TUI that becomes a *code block*, which means you
 *   see raw markdown markers like `**bold**`, `*italic*`, and pipe tables.
 *
 * What this extension does
 * 1) **Interactive TUI**: patches pi's Markdown component to:
 *    - unwrap an *outer* ```markdown / ```md fence (so the content is parsed as markdown)
 *    - optionally hide heading hash prefixes (###)
 *    - optionally hide code fences (```lang / ```), replacing the opening fence with a small language label
 *
 * 2) **Print mode** (`pi -p`): post-processes the final assistant message and
 *    replaces its markdown with a terminal-rendered version.
 *
 * Notes
 * - JSON mode (`--mode json`) is skipped because consumers typically want raw markdown.
 * - This extension uses pi's own renderer (`@mariozechner/pi-tui`'s Markdown component)
 *   so output matches interactive mode.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import { DynamicBorder, getMarkdownTheme, getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
	Container,
	Markdown,
	type MarkdownTheme,
	SettingsList,
	Spacer,
	type SettingItem,
	Text,
} from "@mariozechner/pi-tui";

// ---------------------------------------------------------------------------
// Interactive TUI patching
// ---------------------------------------------------------------------------

type TuiPatchOptions = {
	enabled: boolean;
	unwrapOuterMarkdownFence: boolean;
	hideCodeFences: boolean;
	showCodeFenceLanguageLabel: boolean;
	stripHeadingPrefixes: boolean;

	/** Background key from theme (e.g. "toolPendingBg"). Undefined = disabled. */
	codeBlockBgKey?: string;
	/** ANSI prefix for code block background (no reset). Derived from codeBlockBgKey. */
	codeBlockBgAnsi?: string;

	/** Indent (spaces) inserted before each code line. */
	codeBlockIndent: string;
};

type PatchState = {
	/** Increments whenever Markdown instances should re-apply options (e.g. on /reload or /render-md changes). */
	revision: number;
	options: TuiPatchOptions;
	originals: {
		render: (this: unknown, width: number) => string[];
		setText: (this: unknown, text: string) => void;
		renderToken: (this: unknown, token: any, width: number, nextTokenType?: string) => string[];
		renderListItem: (this: unknown, tokens: any[], parentDepth: number) => string[];
	};
};

const OLD_PATCH_STATE_KEY = Symbol.for("pi-commonmarkdown-renderer/patch-state");
const PATCH_STATE_KEY = Symbol.for("pi-render-md/patch-state");

function getPatchState(): PatchState {
	const g = globalThis as any;

	const defaults: TuiPatchOptions = {
		enabled: true,
		unwrapOuterMarkdownFence: true,
		hideCodeFences: true,
		showCodeFenceLanguageLabel: false,
		stripHeadingPrefixes: true,
		codeBlockBgKey: "toolPendingBg",
		codeBlockBgAnsi: undefined,
		codeBlockIndent: "    ", // default: 4-space indent
	};

	// If we already have state (e.g., after /reload), reuse it but backfill any
	// new fields introduced by newer versions of this extension.
	const existingState = (g[PATCH_STATE_KEY] ?? g[OLD_PATCH_STATE_KEY]) as
		| (PatchState & { options?: Partial<TuiPatchOptions>; originals?: any })
		| undefined;

	if (existingState) {
		// Migrate old key -> new key so hot-reloads won't stack patches if the
		// package was renamed.
		g[PATCH_STATE_KEY] = existingState;
		g[OLD_PATCH_STATE_KEY] = existingState;

		const proto = Markdown.prototype as any;

		existingState.revision ??= 0;
		existingState.options = { ...defaults, ...(existingState.options ?? {}) };
		existingState.originals = existingState.originals ?? {};

		// Only backfill missing originals. Never overwrite existing ones (they must
		// remain the true pre-patch methods).
		existingState.originals.render ??= proto.render;
		existingState.originals.setText ??= proto.setText;
		existingState.originals.renderToken ??= proto.renderToken;
		existingState.originals.renderListItem ??= proto.renderListItem;

		return existingState as PatchState;
	}

	const proto = Markdown.prototype as any;
	const state: PatchState = {
		revision: 0,
		options: { ...defaults },
		originals: {
			render: proto.render,
			setText: proto.setText,
			renderToken: proto.renderToken,
			renderListItem: proto.renderListItem,
		},
	};

	g[PATCH_STATE_KEY] = state;
	g[OLD_PATCH_STATE_KEY] = state;
	return state;
}

function stripOuterMarkdownFence(text: string): string {
	const trimmed = text.trim();
	// Only unwrap if the *entire* message is fenced.
	const match = trimmed.match(/^```\s*(markdown|md)\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
	if (!match) return text;
	return match[2] ?? "";
}

function patchMarkdownInstance(instance: any, state: PatchState): void {
	const options = state.options;
	if (!options.enabled) return;

	// If the patch revision changed (e.g. after /reload or /render-md settings),
	// force a re-render and allow theme patching to re-run.
	if (instance.__piCommonmarkRevisionApplied !== state.revision) {
		instance.__piCommonmarkRevisionApplied = state.revision;
		// Allow re-application after /reload and after changing /render-md settings.
		instance.__piCommonmarkUnwrapped = false;
		instance.__piCommonmarkThemePatched = false;
		instance.invalidate();
	}

	// 1) Unwrap outer ```markdown fence once per instance.
	if (options.unwrapOuterMarkdownFence && !instance.__piCommonmarkUnwrapped) {
		instance.__piCommonmarkUnwrapped = true;
		const originalText: string = instance.text;
		const unwrapped = stripOuterMarkdownFence(originalText);
		if (unwrapped !== originalText) {
			instance.text = unwrapped;
			// Clear render cache.
			instance.invalidate();
		}
	}

	const theme: MarkdownTheme = instance.theme;
	if (!theme) return;

	// Capture original theme fns once so we can re-apply patch cleanly (important for /reload).
	if (!instance.__piCommonmarkThemeOriginals) {
		instance.__piCommonmarkThemeOriginals = {
			codeBlock: theme.codeBlock,
			codeBlockBorder: theme.codeBlockBorder,
			highlightCode: theme.highlightCode,
			codeBlockIndent: theme.codeBlockIndent,
		};
	}

	const originals = instance.__piCommonmarkThemeOriginals as {
		codeBlock: MarkdownTheme["codeBlock"];
		codeBlockBorder: MarkdownTheme["codeBlockBorder"];
		highlightCode: MarkdownTheme["highlightCode"];
		codeBlockIndent: MarkdownTheme["codeBlockIndent"];
	};

	// Apply code indent (spaces). If we also have background enabled, inject the
	// background prefix into the indent so the indent area has the same background.
	{
		const baseIndent = options.codeBlockIndent ?? (originals.codeBlockIndent ?? "  ");
		theme.codeBlockIndent = options.codeBlockBgAnsi && baseIndent
			? `${options.codeBlockBgAnsi}${baseIndent}`
			: baseIndent;
	}

	// 2) Patch theme functions once per instance (or once per revision).
	if (instance.__piCommonmarkThemePatched) return;
	instance.__piCommonmarkThemePatched = true;

	// Restore originals (prevents stacking wrappers across revisions).
	theme.codeBlock = originals.codeBlock;
	theme.codeBlockBorder = originals.codeBlockBorder;
	theme.highlightCode = originals.highlightCode;

	const applyCodeBg = (s: string): string => {
		if (!options.codeBlockBgAnsi) return s;
		const bg = options.codeBlockBgAnsi;
		// If syntax highlighter emits full resets (0m) or background resets (49m),
		// re-apply the background so padding stays consistent.
		const stable = s.replaceAll("\x1b[0m", `\x1b[0m${bg}`).replaceAll("\x1b[49m", bg);
		return `${bg}${stable}`;
	};

	// Code block background: always wrap code lines and highlighted lines.
	// (applyCodeBg() becomes a no-op when codeBlockBgAnsi is undefined)
	const originalCodeBlock = theme.codeBlock;
	theme.codeBlock = (t: string) => applyCodeBg(originalCodeBlock(t));

	const originalHighlight = theme.highlightCode;
	if (originalHighlight) {
		theme.highlightCode = (code: string, lang?: string) => originalHighlight(code, lang).map(applyCodeBg);
	}

	const originalBorder = theme.codeBlockBorder;
	theme.codeBlockBorder = (t: string) => {
		// If we are not hiding fences, just optionally apply background.
		if (!options.enabled || !options.hideCodeFences) {
			return applyCodeBg(originalBorder(t));
		}
		if (!t.startsWith("```")) return applyCodeBg(originalBorder(t));

		// Opening fence is usually "```lang". Closing fence is "```".
		const lang = t.slice(3).trim();

		// Closing fence -> blank line (optionally with background so the code block
		// looks like a padded box).
		if (!lang) {
			return options.codeBlockBgAnsi ? options.codeBlockBgAnsi : "";
		}

		// Opening fence:
		// - either blank line
		// - or an indented language label
		if (!options.showCodeFenceLanguageLabel) {
			return options.codeBlockBgAnsi ? options.codeBlockBgAnsi : "";
		}

		const indent = theme.codeBlockIndent ?? "  ";
		const label = originalBorder(`‹${lang}›`);
		return applyCodeBg(indent + label);
	};

	// Flush cached render output so new heading/code-fence rules take effect
	// immediately.
	instance.invalidate();
}

function applyTuiMarkdownPatchOnce(): void {
	const g = globalThis as any;
	// We intentionally DO NOT early-return here.
	// Extensions are hot-reloaded via /reload, and we want the newest patch logic
	// to replace the old one within the same process.
	g.__piCommonmarkMarkdownPatched = true;

	const state = getPatchState();
	state.revision++;
	const proto = Markdown.prototype as any;

	// Patch render():
	// - stash the content width so list rendering can size tables correctly
	// - ensure instance is prepared, then delegate
	proto.render = function render(width: number): string[] {
		// Mirror the internal calculation from Markdown.render()
		const paddingX = (this as any).paddingX ?? 0;
		(this as any).__piCommonmarkContentWidth = Math.max(1, width - paddingX * 2);

		patchMarkdownInstance(this, state);
		return state.originals.render.call(this, width);
	};

	// Patch setText(): unwrap outer fence on updates too.
	proto.setText = function setText(text: string): void {
		const options = state.options;
		const nextText = options.enabled && options.unwrapOuterMarkdownFence ? stripOuterMarkdownFence(text) : text;
		// New content: allow render() to apply unwrapping again if options change.
		(this as any).__piCommonmarkUnwrapped = false;
		state.originals.setText.call(this, nextText);
	};

	// Patch renderToken():
	// - keep track of current render width for list-item rendering
	// - hide heading prefixes for H3+
	proto.renderToken = function renderToken(token: any, width: number, nextTokenType?: string): string[] {
		const options = state.options;
		if (!options.enabled || !options.stripHeadingPrefixes || token?.type !== "heading") {
			return state.originals.renderToken.call(this, token, width, nextTokenType);
		}

		const lines: string[] = [];
		const headingLevel: number = token.depth;
		const headingText: string = (this as any).renderInlineTokens(token.tokens || []);

		let styledHeading: string;
		if (headingLevel === 1) {
			styledHeading = this.theme.heading(this.theme.bold(this.theme.underline(headingText)));
		} else if (headingLevel === 2) {
			styledHeading = this.theme.heading(this.theme.bold(headingText));
		} else {
			// Standard markdown renderers do not show the leading ###. We use indentation
			// to still convey depth.
			const indent = "  ".repeat(Math.max(0, headingLevel - 3));
			styledHeading = this.theme.heading(this.theme.bold(indent + headingText));
		}

		lines.push(styledHeading);
		if (nextTokenType !== "space") lines.push("");
		return lines;
	};

	// Patch renderListItem(): allow block elements inside list items
	// (tables, blockquotes, headings, code blocks, hr, ...)
	proto.renderListItem = function renderListItem(tokens: any[], parentDepth: number): string[] {
		const options = state.options;
		if (!options.enabled) {
			return state.originals.renderListItem.call(this, tokens, parentDepth);
		}

		const lines: string[] = [];
		const fullWidth: number = (this as any).__piCommonmarkContentWidth ?? 80;
		// renderList() adds `${indent}  ` for continuation lines, where indent = "  ".repeat(depth)
		const continuationPrefix = 2 * parentDepth + 2;
		const blockWidth = Math.max(20, fullWidth - continuationPrefix);

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			const nextType = tokens[i + 1]?.type;

			if (token.type === "list") {
				// Nested list - render with one additional indent level
				const nestedLines = (this as any).renderList(token, parentDepth + 1);
				lines.push(...nestedLines);
				continue;
			}

			if (token.type === "text") {
				const text =
					token.tokens && token.tokens.length > 0
						? (this as any).renderInlineTokens(token.tokens)
						: token.text || "";
				lines.push(text);
				continue;
			}

			if (token.type === "paragraph") {
				const text = (this as any).renderInlineTokens(token.tokens || []);
				lines.push(text);
				continue;
			}

			// Delegate everything else to the full block renderer.
			// This fixes tables/quotes/headings/code blocks inside list items.
			lines.push(...(this as any).renderToken(token, blockWidth, nextType));
		}

		return lines;
	};
}

type CliMode = "text" | "json" | "rpc" | undefined;

function getCliModeFromArgv(argv: string[]): CliMode {
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--mode" && i + 1 < argv.length) {
			const mode = argv[i + 1];
			if (mode === "text" || mode === "json" || mode === "rpc") return mode;
		}
	}
	return undefined;
}

function toInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value === "string") {
		const n = Number.parseInt(value, 10);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

function parseOnOff(value: unknown, defaultValue: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return defaultValue;

	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "on":
		case "yes":
		case "y":
			return true;
		case "0":
		case "false":
		case "off":
		case "no":
		case "n":
			return false;
		default:
			return defaultValue;
	}
}

function normalizeBgKey(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const v = value.trim();
	if (!v) return undefined;
	const lower = v.toLowerCase();
	if (lower === "off" || lower === "none" || lower === "0" || lower === "false") return undefined;
	return v;
}

function parseIndentSpaces(value: unknown, defaultSpaces: number): string {
	const n = toInt(value);
	const spaces = n === undefined ? defaultSpaces : Math.max(0, Math.min(8, n));
	return " ".repeat(spaces);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const LEGACY_SETTINGS_ENTRY_TYPE = "commonmark-renderer:settings";
const SETTINGS_ENTRY_TYPE = "render-md:settings";

type PersistedTuiSettings = {
	unwrapOuterMarkdownFence?: boolean;
	hideCodeFences?: boolean;
	showCodeFenceLanguageLabel?: boolean;
	stripHeadingPrefixes?: boolean;
	codeBlockBgKey?: string; // "toolPendingBg" | "selectedBg" | ... | "off"
	codeIndentSpaces?: number; // 0..8
};

type PersistedSettings = {
	tui?: PersistedTuiSettings;
};

function readPersistedSettings(sessionManager: { getBranch(): any[] }): PersistedSettings | undefined {
	let latest: unknown;
	for (const entry of sessionManager.getBranch()) {
		if (!entry || entry.type !== "custom") continue;
		if (entry.customType !== SETTINGS_ENTRY_TYPE && entry.customType !== LEGACY_SETTINGS_ENTRY_TYPE) continue;
		latest = entry.data;
	}
	if (!latest || !isRecord(latest)) return undefined;
	return latest as PersistedSettings;
}

function persistTuiSettings(pi: ExtensionAPI, options: TuiPatchOptions): void {
	const data: PersistedSettings = {
		tui: {
			unwrapOuterMarkdownFence: options.unwrapOuterMarkdownFence,
			hideCodeFences: options.hideCodeFences,
			showCodeFenceLanguageLabel: options.showCodeFenceLanguageLabel,
			stripHeadingPrefixes: options.stripHeadingPrefixes,
			codeBlockBgKey: options.codeBlockBgKey ?? "off",
			codeIndentSpaces: options.codeBlockIndent.length,
		},
	};
	pi.appendEntry(SETTINGS_ENTRY_TYPE, data);
}

function refreshTui(ctx: { hasUI: boolean; ui: any }): void {
	if (!ctx.hasUI) return;
	const name = ctx.ui.theme?.name;
	if (typeof name === "string" && name.trim()) {
		ctx.ui.setTheme(name);
	} else {
		// Fallback that still triggers full UI invalidation.
		ctx.ui.setTheme("dark");
	}
}

function createPlainMarkdownTheme(options?: { hideCodeFences?: boolean }): MarkdownTheme {
	const hideCodeFences = options?.hideCodeFences ?? true;
	return {
		heading: (t) => t,
		link: (t) => t,
		linkUrl: (t) => t,
		code: (t) => t,
		codeBlock: (t) => t,
		codeBlockBorder: (t) => (hideCodeFences && t.startsWith("```") ? "" : t),
		quote: (t) => t,
		quoteBorder: (t) => t,
		hr: (t) => t,
		listBullet: (t) => t,
		bold: (t) => t,
		italic: (t) => t,
		strikethrough: (t) => t,
		underline: (t) => t,
		highlightCode: (code) => code.split("\n"),
	};
}

function createAnsiMarkdownTheme(options?: { hideCodeFences?: boolean }): MarkdownTheme {
	const base = getMarkdownTheme();
	const hideCodeFences = options?.hideCodeFences ?? true;

	// Override only what we need.
	return {
		...base,
		codeBlockBorder: (t: string) => (hideCodeFences && t.startsWith("```") ? "" : base.codeBlockBorder(t)),
	};
}

function renderMarkdownToTerminal(markdown: string, width: number, theme: MarkdownTheme): string {
	const md = new Markdown(markdown, 0, 0, theme);

	// Markdown.render() pads each line to `width`. In print mode that looks odd and
	// creates trailing whitespace, so we trim it.
	const lines = md.render(width).map((line) => line.trimEnd());

	// Drop trailing blank lines (common after tables/code blocks)
	while (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}

	return lines.join("\n");
}

function findLastAssistantMessage(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role === "assistant") return msg as AssistantMessage;
	}
	return undefined;
}

function extractAssistantText(msg: AssistantMessage): string {
	return msg.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

function hasToolCalls(msg: AssistantMessage): boolean {
	return msg.content.some((c) => c.type === "toolCall");
}

export default function renderMd(pi: ExtensionAPI) {
	// -----------------------------------------------------------------------
	// Flags
	// -----------------------------------------------------------------------

	// Print mode rendering
	pi.registerFlag("commonmark", {
		description: "Render assistant markdown in print mode (default: enabled)",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("no-commonmark", {
		description: "Disable commonmark rendering in print mode (overrides --commonmark)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("commonmark-style", {
		description: "Print mode style: auto | ansi | plain (default: auto)",
		type: "string",
		default: "auto",
	});
	pi.registerFlag("commonmark-width", {
		description: "Print mode width: auto | <n> (default: auto)",
		type: "string",
		default: "auto",
	});

	// Interactive TUI patching
	pi.registerFlag("commonmark-tui", {
		description: "Patch pi TUI markdown rendering (default: enabled)",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("no-commonmark-tui", {
		description: "Disable TUI markdown patching (overrides --commonmark-tui)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("commonmark-tui-unfence", {
		description: "TUI: unwrap an outer ```markdown fence (on|off, default: on)",
		type: "string",
		default: "on",
	});
	pi.registerFlag("commonmark-tui-hide-fences", {
		description: "TUI: hide ``` fences for code blocks (on|off, default: on)",
		type: "string",
		default: "on",
	});
	pi.registerFlag("commonmark-tui-code-label", {
		description: "TUI: when hiding fences, show a small language label like ‹ts› (on|off, default: off)",
		type: "string",
		default: "off",
	});
	pi.registerFlag("commonmark-tui-code-bg", {
		description:
			"TUI: code block background (off|selectedBg|toolPendingBg|customMessageBg|userMessageBg, default: toolPendingBg)",
		type: "string",
		default: "toolPendingBg",
	});
	pi.registerFlag("commonmark-tui-code-indent", {
		description: "TUI: code indentation spaces (0..8, default: 4)",
		type: "string",
		default: "4",
	});
	pi.registerFlag("commonmark-tui-strip-heading-prefix", {
		description: "TUI: hide heading hash prefixes (###) for H3+ (on|off, default: on)",
		type: "string",
		default: "on",
	});

	// We mutate assistant messages for *display* in print mode.
	// If print mode sends multiple prompts in one process, that mutation would
	// leak into subsequent LLM context. To prevent that, we keep the original
	// markdown and restore it in the `context` event.
	const originalMarkdownByAssistantTimestamp = new Map<number, string>();

	const renderMdCommandDescription =
		"Configure render-md markdown rendering (interactive). Usage: /render-md (opens settings UI) | /render-md status | label on|off | hide-fences on|off | bg <key|off> | indent <0..8> | headings on|off | unfence on|off";

	const renderMdCommandHandler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			if (!ctx.hasUI) {
				ctx.ui.notify("render-md: TUI settings only available in interactive mode", "info");
				return;
			}

			applyTuiMarkdownPatchOnce();
			const state = getPatchState();

			const commit = () => {
				// Force Markdown instances to re-apply options on next render.
				state.revision++;
				persistTuiSettings(pi, state.options);
				refreshTui(ctx);
			};

			const recomputeBgAnsi = () => {
				state.options.codeBlockBgAnsi = undefined;
				if (!state.options.codeBlockBgKey) return;
				try {
					state.options.codeBlockBgAnsi = ctx.ui.theme.getBgAnsi(state.options.codeBlockBgKey as any);
				} catch {
					state.options.codeBlockBgAnsi = undefined;
					state.options.codeBlockBgKey = undefined;
				}
			};

			const openSettingsUi = async (): Promise<void> => {
				const items: SettingItem[] = [
					{
						id: "enabled",
						label: "Patch enabled",
						description: "Read-only. Controlled via --commonmark-tui/--no-commonmark-tui flags.",
						currentValue: state.options.enabled ? "on" : "off",
					},
					{
						id: "unfence",
						label: "Unwrap outer ```markdown fence",
						description: "If the entire message is wrapped in ```markdown ... ``` or ```md ... ```",
						currentValue: state.options.unwrapOuterMarkdownFence ? "on" : "off",
						values: ["on", "off"],
					},
					{
						id: "hide-fences",
						label: "Hide code fences (```)",
						description: "Hide the literal ```lang / ``` lines for code blocks",
						currentValue: state.options.hideCodeFences ? "on" : "off",
						values: ["on", "off"],
					},
					{
						id: "code-label",
						label: "Show code language label",
						description: "When hiding fences, show a small label like ‹ts›",
						currentValue: state.options.showCodeFenceLanguageLabel ? "on" : "off",
						values: ["on", "off"],
					},
					{
						id: "headings",
						label: "Hide heading prefixes (###) for H3+",
						description: "Hide the leading ### for H3+ headings (more like typical renderers)",
						currentValue: state.options.stripHeadingPrefixes ? "on" : "off",
						values: ["on", "off"],
					},
					{
						id: "code-bg",
						label: "Code block background",
						description: "Theme background key for code blocks",
						currentValue: state.options.codeBlockBgKey ?? "off",
						values: ["toolPendingBg", "selectedBg", "customMessageBg", "userMessageBg", "off"],
					},
					{
						id: "code-indent",
						label: "Code block indent",
						description: "Number of spaces to indent code block lines (0..8)",
						currentValue: String(state.options.codeBlockIndent.length),
						values: ["0", "1", "2", "3", "4", "5", "6", "7", "8"],
					},
				];

				await ctx.ui.custom<void>(
					(tui, theme, _keybindings, done) => {
						const container = new Container();

						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
						container.addChild(new Text(theme.fg("accent", theme.bold("Render MD")), 1, 0));
						container.addChild(new Spacer(1));

						const settingsList = new SettingsList(
							items,
							Math.min(items.length, 12),
							getSettingsListTheme(),
							(id, newValue) => {
								switch (id) {
									case "unfence":
										state.options.unwrapOuterMarkdownFence = newValue === "on";
										commit();
										return;
									case "hide-fences":
										state.options.hideCodeFences = newValue === "on";
										commit();
										return;
									case "code-label":
										state.options.showCodeFenceLanguageLabel = newValue === "on";
										commit();
										return;
									case "headings":
										state.options.stripHeadingPrefixes = newValue === "on";
										commit();
										return;
									case "code-bg":
										state.options.codeBlockBgKey = normalizeBgKey(newValue);
										recomputeBgAnsi();
										commit();
										return;
									case "code-indent": {
										const n = toInt(newValue) ?? 0;
										const spaces = Math.max(0, Math.min(8, Math.trunc(n)));
										state.options.codeBlockIndent = " ".repeat(spaces);
										commit();
										return;
									}
								}
							},
							() => done(undefined),
							{ enableSearch: true },
						);

						container.addChild(settingsList);
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

						return {
							render: (w) => container.render(w),
							invalidate: () => container.invalidate(),
							handleInput: (data) => {
								settingsList.handleInput(data);
								tui.requestRender();
							},
						};
					},
				);
			};

			const parts = args.trim().split(/\s+/).filter(Boolean);
			const cmd = parts[0];
			const value = parts[1];

			if (!cmd || cmd === "ui" || cmd === "menu") {
				await openSettingsUi();
				return;
			}

			switch (cmd) {
				case "status": {
					const bg = state.options.codeBlockBgKey ?? "off";
					const indent = state.options.codeBlockIndent.length;
					const lines = [
						`enabled=${state.options.enabled ? "on" : "off"}`,
						`unfence=${state.options.unwrapOuterMarkdownFence ? "on" : "off"}`,
						`hide-fences=${state.options.hideCodeFences ? "on" : "off"}`,
						`code-label=${state.options.showCodeFenceLanguageLabel ? "on" : "off"}`,
						`heading-prefix=${state.options.stripHeadingPrefixes ? "hide" : "show"}`,
						`code-bg=${bg}`,
						`code-indent=${indent}`,
					];
					ctx.ui.notify(`render-md: ${lines.join(" • ")}`, "info");
					return;
				}

				case "label": {
					if (!value) {
						ctx.ui.notify("Usage: /render-md label on|off", "info");
						return;
					}
					state.options.showCodeFenceLanguageLabel = parseOnOff(value, state.options.showCodeFenceLanguageLabel);
					ctx.ui.notify(`render-md: code label ${state.options.showCodeFenceLanguageLabel ? "on" : "off"}`, "info");
					commit();
					return;
				}

				case "hide-fences": {
					if (!value) {
						ctx.ui.notify("Usage: /render-md hide-fences on|off", "info");
						return;
					}
					state.options.hideCodeFences = parseOnOff(value, state.options.hideCodeFences);
					ctx.ui.notify(`render-md: hide-fences ${state.options.hideCodeFences ? "on" : "off"}`, "info");
					commit();
					return;
				}

				case "bg": {
					if (!value) {
						ctx.ui.notify(
							"Usage: /render-md bg off|selectedBg|toolPendingBg|customMessageBg|userMessageBg",
							"info",
						);
						return;
					}

					state.options.codeBlockBgKey = normalizeBgKey(value);
					recomputeBgAnsi();
					ctx.ui.notify(
						`render-md: code background ${state.options.codeBlockBgKey ?? "off"}`,
						"info",
					);
					commit();
					return;
				}

				case "indent": {
					if (!value) {
						ctx.ui.notify("Usage: /render-md indent <0..8>", "info");
						return;
					}
					const n = toInt(value);
					if (n === undefined) {
						ctx.ui.notify("render-md: indent must be a number 0..8", "warning");
						return;
					}
					const spaces = Math.max(0, Math.min(8, Math.trunc(n)));
					state.options.codeBlockIndent = " ".repeat(spaces);
					ctx.ui.notify(`render-md: code indent = ${spaces}`, "info");
					commit();
					return;
				}

				case "headings": {
					if (!value) {
						ctx.ui.notify("Usage: /render-md headings on|off", "info");
						return;
					}
					state.options.stripHeadingPrefixes = parseOnOff(value, state.options.stripHeadingPrefixes);
					ctx.ui.notify(
						`render-md: hide heading prefixes ${state.options.stripHeadingPrefixes ? "on" : "off"}`,
						"info",
					);
					commit();
					return;
				}

				case "unfence": {
					if (!value) {
						ctx.ui.notify("Usage: /render-md unfence on|off", "info");
						return;
					}
					state.options.unwrapOuterMarkdownFence = parseOnOff(value, state.options.unwrapOuterMarkdownFence);
					ctx.ui.notify(
						`render-md: unwrap outer markdown fence ${state.options.unwrapOuterMarkdownFence ? "on" : "off"}`,
						"info",
					);
					commit();
					return;
				}

				default:
					ctx.ui.notify(
						"Unknown subcommand. Try: /render-md | status | label | hide-fences | bg | indent | headings | unfence",
						"info",
					);
					return;
			}
	};

	pi.registerCommand("render-md", {
		description: renderMdCommandDescription,
		handler: renderMdCommandHandler,
	});


	// Apply flag values + persisted settings to the global patch state.
	pi.on("session_start", (_event, ctx) => {
		const state = getPatchState();

		const tuiEnabled = pi.getFlag("commonmark-tui") === true && pi.getFlag("no-commonmark-tui") !== true;

		// Base config from CLI flags
		state.options.enabled = tuiEnabled && ctx.hasUI;
		state.options.unwrapOuterMarkdownFence = parseOnOff(pi.getFlag("commonmark-tui-unfence"), true);
		state.options.hideCodeFences = parseOnOff(pi.getFlag("commonmark-tui-hide-fences"), true);
		state.options.showCodeFenceLanguageLabel = parseOnOff(pi.getFlag("commonmark-tui-code-label"), false);
		state.options.stripHeadingPrefixes = parseOnOff(pi.getFlag("commonmark-tui-strip-heading-prefix"), true);
		state.options.codeBlockIndent = parseIndentSpaces(pi.getFlag("commonmark-tui-code-indent"), 4);
		state.options.codeBlockBgKey = normalizeBgKey(pi.getFlag("commonmark-tui-code-bg"));

		// Apply persisted per-session overrides (survives /reload + restarts)
		const persisted = readPersistedSettings(ctx.sessionManager)?.tui;
		if (persisted && isRecord(persisted)) {
			if (typeof persisted.unwrapOuterMarkdownFence === "boolean") {
				state.options.unwrapOuterMarkdownFence = persisted.unwrapOuterMarkdownFence;
			}
			if (typeof persisted.hideCodeFences === "boolean") {
				state.options.hideCodeFences = persisted.hideCodeFences;
			}
			if (typeof persisted.showCodeFenceLanguageLabel === "boolean") {
				state.options.showCodeFenceLanguageLabel = persisted.showCodeFenceLanguageLabel;
			}
			if (typeof persisted.stripHeadingPrefixes === "boolean") {
				state.options.stripHeadingPrefixes = persisted.stripHeadingPrefixes;
			}
			if (typeof persisted.codeBlockBgKey === "string") {
				state.options.codeBlockBgKey = normalizeBgKey(persisted.codeBlockBgKey);
			}
			if (typeof persisted.codeIndentSpaces === "number" && Number.isFinite(persisted.codeIndentSpaces)) {
				const spaces = Math.max(0, Math.min(8, Math.trunc(persisted.codeIndentSpaces)));
				state.options.codeBlockIndent = " ".repeat(spaces);
			}
		}

		// Derive background ANSI prefix from theme.
		state.options.codeBlockBgAnsi = undefined;
		if (state.options.enabled && state.options.codeBlockBgKey) {
			try {
				state.options.codeBlockBgAnsi = ctx.ui.theme.getBgAnsi(state.options.codeBlockBgKey as any);
			} catch {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`render-md: unknown background key "${state.options.codeBlockBgKey}" (try: selectedBg, toolPendingBg, customMessageBg, userMessageBg, or off)`,
						"warning",
					);
				}
				state.options.codeBlockBgAnsi = undefined;
				state.options.codeBlockBgKey = undefined;
			}
		}

		if (state.options.enabled) {
			applyTuiMarkdownPatchOnce();
		}

		// Clear legacy footer status indicator ("md:pretty"/"md:raw").
		// Keeping this ensures older sessions don't keep showing the status after upgrading.
		if (ctx.hasUI) {
			ctx.ui.setStatus("render-md", undefined);
		}
	});

	pi.on("context", (event) => {
		if (originalMarkdownByAssistantTimestamp.size === 0) return;

		for (const msg of event.messages) {
			if (msg.role !== "assistant") continue;
			const assistant = msg as AssistantMessage;
			const original = originalMarkdownByAssistantTimestamp.get(assistant.timestamp);
			if (!original) continue;

			// Replace the first text block, leave the rest untouched.
			// We only mutate messages we previously touched, so in practice there should
			// be exactly one text block.
			for (const block of assistant.content) {
				if (block.type === "text") {
					block.text = original;
					break;
				}
			}
		}

		return { messages: event.messages };
	});

	pi.on("agent_end", (event, ctx) => {
		// Interactive + RPC mode: leave rendering to the UI/client.
		if (ctx.hasUI) return;

		// Skip JSON mode (consumers want raw markdown, not ANSI).
		const cliMode = getCliModeFromArgv(process.argv);
		if (cliMode === "json" || cliMode === "rpc") return;

		// Config flags
		if (pi.getFlag("commonmark") !== true) return;
		if (pi.getFlag("no-commonmark") === true) return;

		const assistant = findLastAssistantMessage(event.messages);
		if (!assistant) return;

		// Don't touch tool-call messages. Even in print mode, mutating those could break
		// the tool call ↔ tool result linkage if another prompt is sent in the same process.
		if (hasToolCalls(assistant)) return;

		const original = extractAssistantText(assistant);
		if (!original.trim()) return;

		// Resolve width
		const widthFlag = pi.getFlag("commonmark-width");
		const widthOverride = typeof widthFlag === "string" && widthFlag !== "auto" ? toInt(widthFlag) : undefined;
		const width = Math.max(20, widthOverride ?? (process.stdout.columns ?? 80));

		// Resolve style
		const styleFlag = String(pi.getFlag("commonmark-style") ?? "auto");
		const wantsAnsi =
			styleFlag === "ansi" ? true : styleFlag === "plain" ? false : Boolean(process.stdout.isTTY);
		const theme = wantsAnsi ? createAnsiMarkdownTheme({ hideCodeFences: true }) : createPlainMarkdownTheme({ hideCodeFences: true });

		const rendered = renderMarkdownToTerminal(original, width, theme);

		// Store original for context restoration, then overwrite message content for output.
		originalMarkdownByAssistantTimestamp.set(assistant.timestamp, original);

		let replaced = false;
		for (const block of assistant.content) {
			if (block.type === "text") {
				block.text = rendered;
				replaced = true;
				break;
			}
		}

		// If there was no text block for some reason, append one.
		if (!replaced) {
			assistant.content.push({ type: "text", text: rendered });
		}
	});
}
