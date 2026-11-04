# Ink Skill

Ink framework reference docs. Covers the React-based CLI renderer, components (`<Text>`, `<Box>`, `<Static>`, `<Transform>`), hooks (`useInput`, `useApp`, `useFocus`, etc.), Flexbox layout, testing, and accessibility.

## Install

### AI Coding Assistants

Add the skill to your AI coding assistant for richer context:

```bash
npx skills add thanhdongnguyen/ink-skill
```

This works with Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, Goose, OpenCode, and Windsurf.

## Usage

Once installed, the skill appears in the agent's available skills list. The agent loads it automatically when working on Ink tasks.

Use the `/ink` command to load the skill and get contextual guidance:

```
/ink create a CLI app with a progress bar
```

## Structure

```
skill/ink/
├── SKILL.md              # Main manifest + decision trees
└── references/           # Framework and concept subdirectories
    ├── core/             # Core API (5-file pattern)
    ├── components/       # Text, Box, Static, Transform, etc.
    ├── hooks/            # useInput, useApp, useFocus, etc.
    ├── layout/           # Yoga/Flexbox layout system
    ├── testing/          # ink-testing-library
    └── accessibility/    # Screen reader support & ARIA

command/ink.md            # /ink entrypoint
```

### Decision Trees

The main `SKILL.md` contains decision trees for:
- Displaying content (text, boxes, borders, backgrounds)
- Handling user input (keyboard, focus management)
- Layout and positioning (flexbox, dimensions, spacing)
- App lifecycle (render, unmount, exit)
- Testing (ink-testing-library, snapshots)
- Accessibility (screen reader, ARIA roles)
- Troubleshooting (common issues, gotchas)

## Topics Covered

**Components**: Text, Box, Newline, Spacer, Static, Transform

**Hooks**: useInput, useApp, useStdin, useStdout, useStderr, useFocus, useFocusManager, useCursor, useIsScreenReaderEnabled

**API**: render(), renderToString(), measureElement()

**Cross-cutting**: Layout (Yoga/Flexbox), Testing (ink-testing-library), Accessibility (ARIA)

## Credits & Inspiration

This skill's structure and patterns are inspired by:

- **[opentui-skill](https://github.com/msmps/opentui-skill)** by [msmps](https://github.com/msmps) — demonstrating decision trees, progressive disclosure, and the multi-file reference pattern.
- **[Ink](https://github.com/vadimdemedes/ink)** by [Vadim Demedes](https://github.com/vadimdemedes) — React for CLIs.

## License

MIT
