# Production Best Practices for an Ink TypeScript TUI

## Purpose

This document defines architectural, interaction, reliability, and release practices for building a production-quality terminal user interface with Ink and TypeScript.

The central principle is:

```text
Ink renders the current state.
The application runtime owns behaviour.
The persistence layer owns durable truth.
Typed commands and events connect them.
```

Ink should capture terminal input and render application state. It should not own business rules, database writes, file parsing, workflow orchestration, or recovery logic.

---

## 1. Architecture

Use a layered architecture:

```text
Terminal input
  -> command
  -> application runtime
  -> domain operation
  -> event
  -> application state machine
  -> Ink renderer
```

Each layer has a distinct responsibility.

### Ink layer

Responsible for:

- Rendering screens and components
- Capturing keyboard input
- Managing focus
- Displaying progress and errors
- Adapting to terminal dimensions
- Presenting confirmations

### Application runtime

Responsible for:

- Executing workflows
- Coordinating domain services
- Managing cancellation
- Applying confirmation policies
- Emitting typed events
- Creating and restoring checkpoints

### Domain layer

Responsible for:

- Business rules
- Valid state transitions
- Transaction categorisation
- Review logic
- Duplicate detection
- Import rules
- Goal calculations

### Infrastructure layer

Responsible for:

- Database access
- File access
- Configuration
- Logging
- Telemetry
- Process and terminal integration

---

## 2. Recommended Project Structure

```text
src/
  cli/
    index.tsx
    App.tsx

    screens/
      HomeScreen.tsx
      ImportScreen.tsx
      ReviewScreen.tsx
      SettingsScreen.tsx

    components/
      AppShell.tsx
      Header.tsx
      StatusBar.tsx
      HelpBar.tsx
      ProgressLine.tsx
      ErrorPanel.tsx
      ConfirmationDialog.tsx
      TransactionReviewCard.tsx
      CommandPalette.tsx

    hooks/
      useApplication.ts
      useShortcuts.ts
      useTerminalCapabilities.ts
      useTerminalSize.ts
      useWorkflowEvents.ts

    input/
      shortcuts.ts
      focus.ts
      keybindings.ts

    rendering/
      formatAmount.ts
      formatDate.ts
      truncateText.ts
      terminalTheme.ts

  application/
    commands.ts
    events.ts
    state.ts
    reducer.ts
    stateMachine.ts
    session.ts

    workflows/
      importCsvWorkflow.ts
      weeklyReviewWorkflow.ts
      categorisationWorkflow.ts

    policies/
      confirmationPolicy.ts
      retryPolicy.ts

    checkpoints/
      checkpointStore.ts
      checkpointTypes.ts

  domain/
    transactions/
    categories/
    imports/
    goals/
    reviews/
    insights/

  infrastructure/
    db/
    files/
    logging/
    telemetry/
    config/
    terminal/

  shared/
    errors/
    result/
    validation/
    types/
```

The exact directory structure can remain smaller at first, but the dependency direction should remain clear:

```text
cli -> application -> domain
                -> infrastructure
```

The domain layer should not depend on Ink, terminal APIs, or React.

---

## 3. Model the Application as Explicit States

Avoid representing the entire application through scattered booleans such as:

```ts
isLoading
isReviewing
hasError
showConfirmation
isFinished
```

These combinations easily produce impossible states.

Prefer an explicit application state:

```ts
type AppState =
  | { status: "home" }
  | { status: "import.selecting-file" }
  | { status: "import.validating"; filePath: string }
  | {
      status: "import.running";
      workflowId: string;
      progress: ImportProgress;
    }
  | {
      status: "import.confirming";
      preview: ImportPreview;
    }
  | {
      status: "review.active";
      reviewId: string;
      transactionId: string;
    }
  | {
      status: "confirmation";
      request: ConfirmationRequest;
      previousState: RestorableAppState;
    }
  | {
      status: "error";
      error: PresentableError;
      previousState?: RestorableAppState;
    };
```

This makes screen selection predictable:

```tsx
function AppScreen({state}: {state: AppState}) {
  switch (state.status) {
    case "home":
      return <HomeScreen />;

    case "import.running":
      return <ImportScreen progress={state.progress} />;

    case "review.active":
      return <ReviewScreen transactionId={state.transactionId} />;

    case "confirmation":
      return <ConfirmationDialog request={state.request} />;

    case "error":
      return <ErrorPanel error={state.error} />;

    default:
      return assertNever(state);
  }
}
```

Application transitions should be validated by the runtime or state machine, not improvised inside components.

---

## 4. Separate Commands from Events

Commands represent intent:

```ts
type AppCommand =
  | { type: "import.start"; filePath: string }
  | { type: "import.cancel" }
  | { type: "review.approve"; transactionId: string }
  | {
      type: "review.changeCategory";
      transactionId: string;
      categoryId: string;
    }
  | { type: "navigation.back" }
  | { type: "application.quit" };
```

Events represent facts that have already occurred:

```ts
type AppEvent =
  | { type: "import.started"; workflowId: string; filePath: string }
  | {
      type: "import.progressed";
      workflowId: string;
      processed: number;
      total?: number;
    }
  | {
      type: "import.completed";
      workflowId: string;
      importId: string;
    }
  | { type: "import.cancelled"; workflowId: string }
  | {
      type: "review.categoryChanged";
      transactionId: string;
      categoryId: string;
    }
  | {
      type: "operation.failed";
      operation: string;
      error: ApplicationError;
    };
```

The flow becomes:

```text
User presses a key
  -> component dispatches command
  -> runtime validates and executes command
  -> runtime emits event
  -> reducer updates state
  -> Ink re-renders
```

Components should not perform domain operations directly.

---

## 5. Keep Ink Components Small and Declarative

A component should primarily answer:

> What should be displayed for the current state?

Good component responsibilities:

```text
TransactionReviewCard
  -> render transaction details and available actions

ImportProgress
  -> render current import progress

CategorySelector
  -> render categories and current selection

ConfirmationDialog
  -> render a pending confirmation request

StatusBar
  -> render application status

HelpBar
  -> render currently available shortcuts
```

Avoid a single `App.tsx` that handles:

- File parsing
- Database access
- Keyboard shortcuts
- Business validation
- Progress calculation
- Error conversion
- Layout
- Navigation
- Confirmation logic

`App.tsx` should compose providers, select the current screen, and coordinate top-level lifecycle behaviour.

---

## 6. Treat Focus as Application State

Focus management is one of the main differences between a basic CLI and a reliable TUI.

Only the focused control should process navigational or editing input.

Examples of focusable regions:

- Main navigation
- Transaction review card
- Category selector
- Search input
- Confirmation dialog
- Command palette

Represent focus explicitly:

```ts
type FocusTarget =
  | "navigation"
  | "transaction"
  | "category-selector"
  | "search"
  | "confirmation";
```

Rules:

- Opening a modal must move focus into the modal.
- Closing a modal must restore the previous focus.
- Global shortcuts must not interfere with text input.
- Hidden components must not receive input.
- The focused item must be visually identifiable without relying only on colour.
- `Tab`, arrow keys, and escape behaviour should be consistent across screens.

Avoid registering unrelated `useInput` handlers throughout the component tree without a clear ownership model.

---

## 7. Centralise Keyboard Shortcuts

Use a single shortcut registry rather than defining undocumented keys inside components.

```ts
type Shortcut = {
  id: string;
  keys: readonly string[];
  label: string;
  scope:
    | "global"
    | "home"
    | "import"
    | "review"
    | "category-selector"
    | "confirmation";
  command: AppCommand["type"];
};
```

Example:

```text
Global
  ?        Show help
  Esc      Go back or close
  Ctrl+C   Cancel or quit

Review
  A        Approve
  C        Change category
  S        Split transaction
  N        Next transaction
  P        Previous transaction

Selection lists
  ↑ / K    Previous option
  ↓ / J    Next option
  Enter    Select
  Esc      Cancel
```

The same registry should power:

- Input handling
- Footer hints
- Help screens
- Documentation
- Shortcut conflict detection

Do not assign important actions to undiscoverable shortcuts without also displaying them.

---

## 8. Distinguish Navigation, Editing, and Command Modes

A TUI often becomes easier to operate when input behaviour changes deliberately by context.

Possible modes:

```ts
type InputMode =
  | "navigation"
  | "editing"
  | "selection"
  | "confirmation"
  | "command-palette";
```

In editing mode:

- Printable characters should edit the current value.
- Global single-letter commands should be disabled.
- Escape should leave editing mode.
- Pasted text should be treated as text, not individual commands.

In confirmation mode:

- Only confirmation-specific commands should be accepted.
- Background screens must not process keyboard input.

The active input mode should be visible when ambiguity is possible.

---

## 9. Handle Paste Input Safely

Pasted input may arrive differently from manually typed input.

For text fields:

- Treat a paste as one logical input operation.
- Do not interpret pasted characters as keyboard shortcuts.
- Validate the complete pasted value after insertion.
- Preserve line breaks only where multiline input is supported.
- Set sensible size limits for pasted content.

This is particularly important for:

- File paths
- Search queries
- Notes
- Configuration values
- Imported identifiers

---

## 10. Support Terminal Capability Differences

Do not assume every terminal supports:

- Full Unicode
- True colour
- Mouse input
- Raw mode
- ANSI escape sequences
- A large viewport
- Interactive input

Detect capabilities where practical and provide fallbacks.

Useful modes include:

```text
--plain
--no-color
--ascii
--non-interactive
--json
```

Also respect common conventions such as the `NO_COLOR` environment variable.

Example fallbacks:

```text
Preferred:
  ✓ Import completed
  ├─ 240 transactions
  └─ 3 duplicates

ASCII fallback:
  [OK] Import completed
  |- 240 transactions
  `- 3 duplicates
```

Never use colour as the only indication of status.

---

## 11. Design Responsive Terminal Layouts

Terminal dimensions can change at any time.

The UI should respond to:

- Window resizing
- Split panes
- Small mobile terminals
- Narrow embedded terminals
- Large desktop terminals

Recommended behaviour:

```text
Wide terminal
  -> multi-column layout where useful

Narrow terminal
  -> single-column layout

Very narrow terminal
  -> hide secondary metadata before hiding primary actions
```

Establish layout priorities:

1. Current task
2. Required user action
3. Error or warning
4. Primary data
5. Progress
6. Secondary metadata
7. Decorative elements

Do not let borders and padding consume most of a small screen.

Long content should be wrapped, truncated, paginated, or placed in a scrollable view deliberately. Never rely on accidental terminal clipping.

---

## 12. Choose Between Inline and Full-Screen Rendering Deliberately

There are two broad TUI behaviours.

### Inline interface

The UI renders in normal terminal scrollback.

Suitable for:

- Short workflows
- Commands that produce useful historical output
- Build-style progress
- Import summaries
- Tools frequently used in scripts

Advantages:

- Previous output remains visible
- Easier debugging
- More compatible with terminal history

### Full-screen interface

The application occupies a dedicated terminal screen.

Suitable for:

- Long interactive reviews
- Dashboards
- Multi-panel navigation
- Editors
- Persistent sessions

Requirements:

- Restore the terminal on every exit path
- Handle crashes and signals
- Preserve important summaries before leaving
- Avoid trapping users in an unusable terminal state

Do not enter full-screen mode merely for visual effect.

---

## 13. Keep Completed Output Stable

For progress-oriented workflows, separate completed output from live output.

```text
Completed:
  ✓ CSV validated
  ✓ 242 rows parsed
  ✓ 3 duplicates identified

Current:
  Importing transactions
  143 of 242
```

Completed lines should not be repeatedly re-rendered where the framework supports stable or static output.

This reduces flickering, improves scrollback, and lowers rendering cost.

---

## 14. Control Rendering Frequency

High-frequency events can overwhelm a terminal.

Do not re-render for:

- Every byte read
- Every parsed character
- Every log message
- Every database row
- Every internal progress update

Instead:

- Coalesce progress events
- Render meaningful increments
- Batch state updates
- Keep event histories bounded
- Avoid recomputing expensive formatting during every render
- Use stable React keys
- Memoise expensive components only where measurement shows value

For example, an import may process thousands of rows per second while updating the visible progress only periodically.

The runtime should retain accurate internal progress even when the renderer receives fewer updates.

---

## 15. Make Long-Running Operations Cancellable

Every long-running operation should have a cancellation strategy.

```ts
type WorkflowContext = {
  signal: AbortSignal;
  emit: (event: AppEvent) => void;
};
```

Cancellation should propagate through:

- File parsing
- Network calls
- Database operations
- Background workers
- Retry loops
- Timers

Cancellation is not the same as failure.

```ts
type WorkflowOutcome<T> =
  | { status: "completed"; value: T }
  | { status: "cancelled" }
  | { status: "failed"; error: ApplicationError };
```

When cancellation cannot safely interrupt an operation, the UI should explain that the current atomic step must finish first.

---

## 16. Define Progress Semantics

Use determinate progress only when the total amount of work is known.

```text
Determinate:
  Importing 143 of 242 transactions

Indeterminate:
  Detecting bank statement format…
```

Progress indicators should communicate:

- What operation is running
- Whether the operation is still active
- How much has completed, when known
- Whether cancellation is possible
- Whether the application is retrying
- What the user should do next

Avoid perpetual spinners without context.

For slower operations, include elapsed time or the current stage rather than speculative completion estimates.

---

## 17. Design for Resumability

Long-running or user-reviewed workflows should support recovery.

```ts
type WorkflowCheckpoint = {
  workflowId: string;
  workflowType: "csv-import" | "weekly-review";
  version: number;
  status: "running" | "paused" | "completed" | "failed";
  cursor?: {
    rowNumber?: number;
    transactionId?: string;
  };
  inputReference?: string;
  updatedAt: string;
};
```

Example behaviours:

```text
CSV import interrupted
  -> resume safely or restart idempotently

Weekly review interrupted
  -> continue from the next unreviewed transaction

Batch categorisation interrupted
  -> restore the latest valid checkpoint
```

Checkpoint formats should be versioned so application upgrades can detect incompatible state.

---

## 18. Make Operations Idempotent Where Possible

Retrying a workflow should not duplicate data or corrupt state.

Useful techniques:

- Stable import identifiers
- Content hashes
- Database uniqueness constraints
- Transaction boundaries
- Upserts
- Operation journals
- Idempotency keys
- Explicit workflow versions

A resumed import should know which records have already been processed.

---

## 19. Persist Important User Decisions Before Side Effects

For consequential actions:

```text
User confirms import
  -> persist confirmation or operation record
  -> execute import

User changes transaction category
  -> persist audit record
  -> apply category change

User completes weekly review
  -> persist review result
  -> mark workflow complete
```

This reduces ambiguity when the process stops during an operation.

Where possible, the decision and resulting state change should occur within the same database transaction.

---

## 20. Centralise Confirmation and Risk Policies

Do not scatter destructive-action prompts throughout components.

```ts
type RiskLevel = "low" | "medium" | "high";

type ActionPolicy = {
  action: string;
  risk: RiskLevel;
  requiresConfirmation: boolean;
  reversible: boolean;
};
```

Example policy:

```text
Low risk
  Read CSV
  Preview transactions
  View dashboard

Medium risk
  Import transactions
  Update categories
  Change goals

High risk
  Delete an import batch
  Reset application data
  Bulk overwrite categories
```

Confirmation prompts should state:

- The exact action
- The affected data
- Whether it is reversible
- The default safe choice
- The command needed to proceed

Avoid vague prompts such as:

```text
Are you sure?
```

Prefer:

```text
Delete import batch “June Current Account”?

This removes 242 imported transactions.
The operation can be restored from the operation history.

[D] Delete   [Esc] Cancel
```

---

## 21. Make Destructive Actions Reversible

Prefer:

- Soft deletion
- Archived import batches
- Undoable category changes
- Operation history
- Review checkpoints
- Database transactions
- Restorable backups

```ts
type BatchOperation = {
  id: string;
  type: "import" | "categorisation-update" | "delete";
  status: "pending" | "applied" | "reverted";
  reversible: boolean;
  createdAt: string;
};
```

Useful commands might include:

```text
kakeibo operations list
kakeibo undo last
kakeibo imports rollback <import-id>
```

Undo should be implemented through explicit inverse operations, not through undocumented database manipulation.

---

## 22. Support Interactive and Non-Interactive Modes

A production CLI should work for humans, scripts, and automation.

```text
Interactive:
  kakeibo review
  kakeibo import bank.csv

Non-interactive:
  kakeibo import bank.csv --json
  kakeibo export transactions --format csv
  kakeibo review --week 2026-W22 --non-interactive
```

Use strict output separation:

```text
Human interface       -> Ink
Machine-readable data -> stdout
Diagnostics           -> stderr
Durable data          -> database or files
```

When `--json` is enabled:

- Do not render decorative UI
- Do not print progress to stdout
- Emit valid machine-readable output
- Put errors in a documented structure
- Return a meaningful exit code

When no interactive terminal is available, either switch automatically to a plain mode or fail with a clear explanation.

---

## 23. Use Meaningful Exit Codes

Exit status is part of the CLI contract.

Example convention:

```text
0   Success
1   General failure
2   Invalid arguments or configuration
3   User cancellation
4   Validation failure
5   External dependency failure
6   Partial completion
```

The exact values matter less than consistency and documentation.

Do not return success after a failed or partially completed operation unless the command contract explicitly defines that behaviour.

---

## 24. Handle Shutdown Correctly

Expected behaviour:

```text
No active operation
  -> exit cleanly

Cancellable operation active
  -> first Ctrl+C requests cancellation

Unsaved user work
  -> prompt to save or discard

Second Ctrl+C
  -> force termination
```

On controlled shutdown:

- Stop accepting new commands
- Signal active workflows to cancel
- Persist checkpoints
- Flush logs
- Close database connections
- Stop workers and timers
- Restore terminal state
- Leave raw mode
- Restore the cursor
- Exit with the correct status

Signal handling should not leave the terminal without echo, cursor visibility, or normal keyboard behaviour.

---

## 25. Validate External Input at Boundaries

Validate:

- CLI arguments
- File paths
- CSV structures
- Dates
- Currencies
- Amounts
- Account identifiers
- Category names
- Configuration files
- Environment variables
- Database records loaded from older versions

Use this flow:

```text
Raw input
  -> parser
  -> schema validation
  -> normalisation
  -> domain object
  -> workflow
```

TypeScript types do not validate runtime data.

Validation failures should identify:

- The invalid value
- Its source
- The expected format
- Whether the problem can be corrected interactively

---

## 26. Present Errors for Users, Operators, and Developers

Maintain separate error representations.

```ts
type ApplicationError = {
  code: string;
  message: string;
  cause?: unknown;
  context?: Record<string, unknown>;
  recoverable: boolean;
};

type PresentableError = {
  title: string;
  explanation: string;
  suggestedAction?: string;
  technicalReference?: string;
};
```

The TUI should show:

- What failed
- What was affected
- Whether data was changed
- Whether retrying is safe
- What the user can do next

Technical stack traces should normally go to logs, not into the main interface.

---

## 27. Preserve Context During Errors

An error should not unnecessarily destroy the current workflow.

Examples:

```text
Category update fails
  -> retain the transaction and selected category
  -> allow retry or cancellation

Import validation fails
  -> retain the selected file
  -> show specific validation problems

Network operation fails
  -> retain user-entered values
  -> offer retry where safe
```

Recoverable errors should return the user to a usable state.

---

## 28. Design for Accessibility

Terminal interfaces have accessibility limitations, so provide alternatives.

Practices:

- Do not communicate meaning through colour alone.
- Use text labels such as `ERROR`, `WARNING`, and `COMPLETE`.
- Provide a plain-output mode.
- Avoid rapid animations.
- Allow animation and spinners to be disabled.
- Keep focus order predictable.
- Ensure the focused element has a non-colour indicator.
- Avoid essential information displayed only in temporary status updates.
- Use concise, descriptive labels.
- Provide ASCII fallbacks for Unicode symbols.
- Avoid excessive redraws that interfere with assistive terminal software.

A non-interactive or plain mode should expose the same essential operations as the full TUI.

---

## 29. Keep Workflow State Out of React

React state should contain current presentation state, not the entire application history.

```text
React state
  Current screen
  Focus target
  Selected option
  Visible progress
  Open dialog

Application runtime state
  Active workflow
  Cancellation controller
  Pending command
  Current checkpoint
  Operation status

Durable state
  Transactions
  Imports
  Categories
  Reviews
  Goals
  Operation history

Logs
  Append-only diagnostics
```

This separation reduces render complexity and makes workflows testable without mounting the TUI.

---

## 30. Use Structured Logging

Visible terminal output is not a substitute for logs.

```ts
logger.info("csv_import_started", {
  workflowId,
  filePath,
  accountId
});
```

Separate:

```text
TUI
  Friendly status and user actions

Technical logs
  Structured diagnostics

Audit trail
  User-visible changes to financial data
```

Avoid writing secrets, complete account numbers, or sensitive transaction descriptions into logs unless explicitly required and protected.

---

## 31. Add Telemetry at Workflow Boundaries

Useful instrumentation points include:

- Command started
- Command completed
- Command failed
- Workflow started
- Workflow cancelled
- Workflow completed
- Workflow resumed
- Validation duration
- File parsing duration
- Database write duration
- Number of imported records
- Number of duplicate records
- Review completion rate
- UI render failures

Telemetry should not include sensitive financial content.

The application should remain functional when telemetry is unavailable.

---

## 32. Test the Runtime Without Ink

Most tests should target the application and domain layers.

Test:

- Parsers
- Validation
- Duplicate detection
- Categorisation rules
- Command handling
- State transitions
- Workflow event sequences
- Cancellation
- Checkpoint recovery
- Confirmation policies
- Idempotency
- Exit-code selection
- Non-interactive output

Example:

```ts
const events = await collectEvents(
  importCsvWorkflow({
    filePath: "fixtures/bank.csv",
    signal: new AbortController().signal
  })
);

expect(events).toContainEqual({
  type: "import.completed",
  workflowId: expect.any(String),
  importId: expect.any(String)
});
```

---

## 33. Test TUI Interaction Separately

TUI tests should focus on presentation and interaction contracts.

Test:

- Screen selection for each application state
- Visible keyboard hints
- Focus transitions
- Confirmation behaviour
- Small-terminal layouts
- Error rendering
- Colour-disabled rendering
- ASCII fallback
- Non-TTY behaviour
- Ctrl+C behaviour
- Resize handling
- Text truncation and wrapping

Avoid making broad snapshot tests the only form of coverage. Small semantic assertions are generally more stable.

---

## 34. Use a Terminal Compatibility Matrix

Test on representative environments:

```text
Operating systems
  Linux
  macOS
  Windows, when supported

Terminal modes
  Interactive TTY
  Piped stdout
  Redirected output
  CI environment

Terminal dimensions
  Narrow
  Typical
  Wide

Capabilities
  Colour
  No colour
  Unicode
  ASCII fallback
```

Also test with slow operations and high-frequency progress events to identify flicker and input lag.

---

## 35. Package Safely

Use an explicit package allowlist:

```json
{
  "bin": {
    "kakeido": "./dist/cli/index.js"
  },
  "files": [
    "dist",
    "README.md",
    "LICENSE",
    "package.json"
  ]
}
```

Inspect the package before publishing:

```bash
npm pack --dry-run
npm pack --json
```

Prevent accidental publishing of:

```text
src/
.env
*.test.*
__tests__/
coverage/
fixtures/private/
.local/
temporary databases
development configuration
```

Source maps should be an explicit release decision. Do not publish them accidentally.

---

## 36. Verify the Installed Artefact

Testing the source repository is not enough.

Release validation should:

1. Build the application.
2. Create the package archive.
3. Install the archive into a clean temporary directory.
4. Execute the installed binary.
5. Verify interactive help.
6. Verify non-interactive output.
7. Verify the published file list.
8. Verify there are no undeclared runtime dependencies.
9. Verify terminal cleanup after normal and abnormal exits.

This catches packaging problems that local source execution does not expose.

---

## 37. Recommended Production Architecture

```text
1. CLI argument parser
2. Terminal capability detector
3. Application state machine
4. Typed command dispatcher
5. Workflow runtime
6. Typed event stream
7. Ink renderer
8. Focus and input manager
9. Cancellation system
10. Durable persistence layer
11. Checkpoint and resume system
12. Confirmation and risk policy
13. Non-interactive output adapter
14. Structured logging
15. Audit trail
16. Telemetry hooks
17. Release-package verification
```

---

## 38. Production Readiness Checklist

### Architecture

- [ ] Ink contains presentation logic only.
- [ ] Domain code does not depend on React or terminal APIs.
- [ ] Commands and events are typed separately.
- [ ] Application states and transitions are explicit.
- [ ] Long-running workflows support cancellation.
- [ ] Important workflows support resumability.

### Interaction

- [ ] Focus ownership is explicit.
- [ ] Keyboard shortcuts are centralised.
- [ ] Current shortcuts are discoverable.
- [ ] Text-input mode disables conflicting shortcuts.
- [ ] Modals capture input exclusively.
- [ ] Ctrl+C behaviour is predictable.

### Terminal behaviour

- [ ] Resize behaviour is tested.
- [ ] Narrow layouts remain usable.
- [ ] Colour can be disabled.
- [ ] ASCII fallback exists where needed.
- [ ] Non-TTY execution is supported or rejected clearly.
- [ ] Terminal state is restored after exit.

### Reliability

- [ ] Workflows are idempotent where possible.
- [ ] User decisions are persisted safely.
- [ ] Destructive actions are reversible where possible.
- [ ] Errors preserve recoverable user context.
- [ ] Exit codes reflect command outcomes.
- [ ] Partial completion is represented explicitly.

### Performance

- [ ] High-frequency events are coalesced.
- [ ] Rendered history is bounded.
- [ ] Completed output remains stable.
- [ ] Large datasets are not stored entirely in React state.
- [ ] Slow operations remain responsive to cancellation.

### Accessibility

- [ ] Meaning does not depend on colour.
- [ ] Focus has a visible text or shape indicator.
- [ ] Plain output mode exists.
- [ ] Essential information is not purely transient.
- [ ] Animations can be disabled.
- [ ] Keyboard navigation is consistent.

### Release

- [ ] Published files use an allowlist.
- [ ] Package contents are inspected in CI.
- [ ] The packed artefact is installed and executed in a clean environment.
- [ ] Source maps are included only intentionally.
- [ ] Development files and secrets are excluded.
- [ ] Interactive and non-interactive modes are release-tested.

---

## Final Rule

```text
The terminal is a constrained and unreliable rendering environment.

The TUI must remain usable when:
  the screen is narrow,
  colour is unavailable,
  input is interrupted,
  work is cancelled,
  the process crashes,
  the session resumes,
  or no interactive terminal exists.
```