# pi-commonmarkdown-renderer

Pi extension that improves **markdown rendering** in:

- **Interactive TUI** (`pi`)
- **Print mode** (`pi -p ...`)

## What it fixes

### 1) “Everything is inside ```markdown … ```”

Some models wrap their entire response like this:

````text
```markdown
# Title

Some **bold** text

| a | b |
|---|---|
| 1 | 2 |
```
````

In pi’s TUI that becomes a *code block*, so you see raw markdown markers (`**`, `|`, etc.) and tables won’t render.

This extension unwraps an **outer** ` ```markdown ` / ` ```md ` fence so the inner content renders as real markdown.

### 2) Code blocks: fences, labels, background

pi’s built-in markdown renderer intentionally shows code fences as a border and usually does not apply a background.

This extension can:
- hide the code fences
- (optionally) show a small language label
- apply a consistent background color using an existing theme bg color (e.g. `toolPendingBg`)

### 3) Block elements inside list items

Tables / code blocks / blockquotes nested under list items can render oddly. This extension patches list-item rendering so
block tokens are rendered using the full block renderer.

## Install (for testing)

### Global (recommended for dev + `/reload`)

Put the extension into the auto-discovery folder:

```bash
mkdir -p ~/.pi/agent/extensions
ln -sf /absolute/path/to/pi-commonmarkdown-renderer/extensions/commonmark-renderer.ts \
  ~/.pi/agent/extensions/commonmark-renderer.ts
```

Then start pi and run:

```
/reload
```

### One-off run

```bash
# Interactive TUI
pi -e ./extensions/commonmark-renderer.ts

# Print mode
pi -e ./extensions/commonmark-renderer.ts -p "Write a markdown table with 3 columns"
```

## Interactive commands

### `/commonmark`

Configure the renderer **at runtime** (interactive TUI only):

- `/commonmark status`
- `/commonmark unfence on|off`
  - unwrap an *outer* ` ```markdown … ``` ` wrapper
- `/commonmark hide-fences on|off`
  - hide the literal ` ```lang ` / ` ``` ` fence lines
- `/commonmark label on|off`
  - when fences are hidden, show a small label like `‹python›`
- `/commonmark bg off|selectedBg|toolPendingBg|customMessageBg|userMessageBg`
  - sets the **background color for code blocks**.
  - `toolPendingBg` is the same background used for “pending tool execution” blocks in the default theme, so it gives
    code blocks a subtle “card” background.
- `/commonmark indent <0..8>`
  - number of spaces to indent each code line
- `/commonmark headings on|off`
  - `on` hides heading prefixes (`###`) for H3+ (more like typical markdown renderers)

### Copy

Pi already provides:

- `/copy` — copies the entire last assistant message.

## Persistence

Settings changed via `/commonmark ...` are persisted **in the current session file** as a custom entry.
That means they survive:

- `/reload`
- restarting pi
- resuming the same session later

New sessions start with the extension defaults.

## CLI flags

### Interactive TUI

- `--no-commonmark-tui` — disable the TUI patch completely
- `--commonmark-tui-unfence on|off` (default: `on`)
- `--commonmark-tui-hide-fences on|off` (default: `on`)
- `--commonmark-tui-code-label on|off` (default: `off`)
- `--commonmark-tui-code-bg off|selectedBg|toolPendingBg|customMessageBg|userMessageBg` (default: `toolPendingBg`)
- `--commonmark-tui-code-indent 0..8` (default: `4`)
- `--commonmark-tui-strip-heading-prefix on|off` (default: `on`)

### Print mode (`pi -p`)

- `--no-commonmark` — disable print-mode rendering
- `--commonmark-style auto|ansi|plain` (default: `auto`)
- `--commonmark-width auto|<n>` (default: terminal width or 80)

## Notes

- JSON mode (`--mode json`) is skipped (it should stay machine-readable).
