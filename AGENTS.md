# AGENTS.md — Samhain POS

## 1. Purpose

This file defines the rules that AI coding agents, primarily Codex, must follow when working on **Samhain POS**.

Samhain POS is a touchscreen point-of-sale application designed for the Samhain festival.

The application is intended to be used in real operating conditions:

* on an Android touchscreen tablet;
* by cashiers who may not be technical;
* while standing;
* during periods of high order volume;
* in a noisy and busy festival environment;
* with a physical receipt printer that may become unavailable, disconnected, out of paper, or fail during an operation;
* with network connectivity that may be unavailable or unreliable.

The project is currently evolving from a prototype toward a reliable production POS.

When making decisions, use the following priority order:

1. reliability of checkout and order handling;
2. speed of use by the cashier;
3. prevention of data loss or duplicated operations;
4. simplicity and clarity of the user experience;
5. maintainability;
6. visual aesthetics.

A visually attractive solution that reduces speed, clarity, or reliability is a worse solution.

---

# 2. Project context

Current main technologies include:

* React;
* TypeScript;
* Vite;
* Tailwind CSS;
* Zustand;
* Vitest;
* Testing Library;
* Capacitor;
* Android native Java integration;
* Android USB Host;
* Epson thermal printer integration;
* ESC/POS printing.

Important areas of the project include:

```text
src/app/
src/components/
src/config/
src/features/
src/mocks/
src/native/
src/printing/
src/services/
src/store/
src/types/
src/utils/

native/android/
android/
scripts/
```

The project currently has no real backend and is progressively moving from mock data toward real business data.

Do not assume the current mock architecture is the final architecture.

However, do not prematurely introduce unnecessary infrastructure either.

---

# 3. General working rules

Before changing code:

1. inspect the files involved;
2. understand the existing workflow;
3. identify the relevant types, state, utilities, services and tests;
4. reuse existing patterns when they are appropriate;
5. understand why the current code exists before replacing it.

Do not start implementing a feature based only on filenames, comments or assumptions.

For a substantial change, establish a short implementation plan before modifying the code.

Prefer incremental changes over broad rewrites.

Modify only the parts of the project that are needed to solve the problem properly.

Do not refactor unrelated code simply because an alternative style is possible.

---

# 4. Agent autonomy

The agent is allowed to:

* modify project files directly;
* create, update and delete code when required by the task;
* add or update tests;
* modify dependencies when justified;
* modify Android native code;
* modify Capacitor integration;
* modify state management;
* refactor existing code;
* modify the architecture when doing so brings a concrete improvement;
* introduce new abstractions when a real need exists;
* remove obsolete development code when it is clearly safe and relevant.

Architecture changes must have a concrete reason such as:

* improved reliability;
* improved testability;
* reduced duplication;
* better separation of responsibilities;
* easier transition from mock data to real data;
* safer handling of critical POS operations.

Do not introduce abstractions merely because they are considered theoretically cleaner.

---

# 5. Changes requiring explicit approval

Unless the user's task explicitly requests one of these changes, ask before:

* migrating to another frontend framework;
* replacing Capacitor;
* replacing Zustand with another state-management library;
* adding a large or infrastructure-heavy dependency;
* introducing a backend or external hosted service;
* introducing mandatory network connectivity;
* removing an existing user-facing feature;
* changing business prices;
* inventing or changing VAT rules;
* changing legal or administrative receipt information;
* inventing product compositions or business rules;
* making destructive data migrations;
* fundamentally changing the order-numbering strategy once real persistent orders exist;
* replacing the current printing technology with Epson ePOS SDK or another printing stack;
* making a production workflow depend on an external service.

When the user explicitly requests a feature that naturally requires one of these changes, do not ask again unnecessarily.

---

# 6. Business data: never invent

Do not invent business information.

This includes, but is not limited to:

* prices;
* VAT rates;
* product compositions;
* menu contents;
* drink sizes;
* legal information;
* SIRET;
* VAT numbers;
* addresses;
* phone numbers;
* payment rules;
* stock quantities;
* operational rules.

If required information is unknown, ask the user.

If temporary data already exists in the repository, preserve its temporary status unless the user explicitly provides confirmed replacement data.

Clearly distinguish:

* confirmed business data;
* mock data;
* temporary data;
* development-only data.

Do not silently convert temporary information into production information.

The application will progressively receive real data. Design changes so that replacing mock data with real data remains straightforward.

---

# 7. Offline and future synchronization

The POS must not become unnecessarily dependent on Internet connectivity.

Prefer designs that allow checkout and critical operations to continue locally.

The project may later gain synchronization between devices or with a backend.

When designing persistent data or services:

* avoid architectures that make future synchronization unnecessarily difficult;
* use stable identifiers where appropriate;
* separate local persistence from UI state;
* distinguish durable business state from temporary UI state;
* do not implement a complex synchronization system before it is actually required.

Prepare for synchronization; do not prematurely build it.

---

# 8. Critical POS operations

Order handling, payment state and printing are critical operations.

Treat them more carefully than cosmetic UI state.

Always think about:

* repeated taps;
* double validation;
* application restart;
* Android process termination;
* printer disconnection;
* partial printing;
* permission denial;
* out-of-paper conditions;
* interrupted operations;
* stale state;
* partial success;
* duplicated commands;
* lost orders;
* retry behavior.

For critical operations, prefer idempotent or resumable workflows when practical.

A payment, order or print operation must not be duplicated merely because the user tapped twice or retried after an error.

Do not use an optimistic UI if it can incorrectly imply that a critical operation succeeded.

---

# 9. Order state and printing

Do not assume that:

```text
successful print = successful order
```

These are separate concerns.

Conceptually keep separate:

```text
order
payment
printing
```

Printing failure must not silently invalidate a successfully recorded sale.

When changing printing behavior, account for partial success.

Example:

```text
customer receipt printed
preparation ticket failed
```

A retry should not blindly repeat successfully completed steps unless explicitly intended.

Preserve the existing separation between ticket rendering and printer transport unless there is a concrete reason to change it.

The current structure around:

```text
customerReceiptRenderer
preparationTicketRenderer
orderPrintService
ReceiptPrinter
native USB transport
```

is useful and should generally remain separated.

---

# 10. Android and printer integration

Android is currently the important native target because the production hardware is an Android touchscreen tablet.

The project currently uses:

* Capacitor;
* Android USB Host;
* a native Java Capacitor plugin;
* direct ESC/POS communication;
* an Epson TM-T88V-oriented printer profile.

Changes to the Android or USB implementation are allowed when necessary.

However:

* preserve working printer behavior whenever possible;
* do not replace the complete printer stack without a concrete need;
* do not migrate to Epson ePOS SDK simply because it exists;
* verify permission handling;
* account for USB device disconnection;
* account for partial writes;
* release claimed interfaces and resources correctly;
* preserve clear error reporting;
* keep hardware-specific implementation out of UI components when possible.

If a change affects printing, identify whether it affects:

```text
ticket rendering
print job orchestration
Capacitor bridge
USB permission
USB transport
printer-specific ESC/POS commands
```

Do not mix these responsibilities unnecessarily.

---

# 11. Architecture philosophy

Prefer the simplest architecture that makes the project:

* understandable;
* reliable;
* testable;
* maintainable;
* evolvable.

Avoid both extremes:

```text
everything inside React components
```

and:

```text
many unnecessary enterprise architecture layers
```

Introduce an abstraction when it solves an actual problem.

Good reasons include:

* separating durable data from UI state;
* isolating native hardware;
* allowing mock data to be replaced;
* making critical logic testable;
* avoiding duplicated business rules.

Do not introduce repositories, factories, adapters, managers, coordinators, providers or service layers purely for naming consistency.

---

# 12. Code quality rules

Use TypeScript strictly.

Prefer precise types.

Avoid `any`.

If `any` is genuinely necessary, keep it localized and explain why.

Prefer:

* explicit domain types;
* pure functions for business calculations;
* prices represented in integer cents;
* predictable state transitions;
* small reusable utilities for genuinely shared logic;
* clear naming;
* early validation at boundaries.

Avoid:

* silent failures;
* large components mixing UI, persistence and business logic;
* duplicated calculations;
* duplicated business rules;
* unexplained magic values;
* global mutable state when avoidable;
* overly permissive types;
* unnecessary type assertions;
* deeply nested conditionals when a clearer structure exists.

Comments should primarily explain **why**, not restate **what** the code already says.

Do not create unnecessary comments for self-explanatory code.

---

# 13. Existing code and reuse

Before introducing a new component, hook, utility or service:

* check whether a suitable implementation already exists;
* extend an existing abstraction if doing so remains coherent;
* avoid creating two different ways to solve the same problem.

Do not force reuse when two concepts are actually different.

Avoid premature generic abstractions.

Three explicit implementations may be clearer than one generic system full of configuration if the use cases are genuinely different.

---

# 14. Tests

Tests are important for business-critical behavior.

Add or update tests when changing behavior that can reasonably be tested.

Prioritize tests around:

* cart calculations;
* prices;
* VAT;
* options and variants;
* product customization;
* order creation;
* persistent state;
* sequence/receipt numbering;
* payment workflows;
* prevention of duplicate operations;
* ticket generation;
* partial print failures;
* retry behavior;
* printer orchestration;
* important regressions.

When tests are added or modified, run:

```bash
pnpm test:run
```

Do not claim tests passed if they were not actually executed.

For changes with broader impact, also consider running as appropriate:

```bash
pnpm lint
pnpm build
```

Do not mechanically run every possible command after every tiny change if it adds no value.

Run the checks relevant to the changes made.

When unable to run a check, state that clearly in the final report.

Android hardware behavior may require manual testing on the real tablet/printer.

Never claim real USB printing has been verified unless it was actually tested on compatible hardware.

---

# 15. Package manager and commands

Use `pnpm`.

Common commands currently include:

```bash
pnpm dev
pnpm build
pnpm lint
pnpm format
pnpm format:check
pnpm test
pnpm test:run

pnpm android:add
pnpm android:sync
pnpm android:open
pnpm build:android-test
pnpm android:install-usb-printer
```

Before changing development/build commands, inspect `package.json` and the relevant scripts.

Be particularly careful about differences between development/test Android builds and eventual production Android builds.

Do not assume that a command named `android:sync` is necessarily production-safe.

---

# 16. Git rules

Never work directly on `main`.

Before implementing changes, use or recommend a dedicated branch.

Branch names must follow a Conventional Commits-inspired naming convention.

Examples:

```text
feat/order-history
feat/product-management
fix/usb-permission
fix/duplicate-order-number
refactor/order-persistence
test/printing-retry
docs/update-agents-guidelines
chore/android-build-config
```

Use short, descriptive lowercase names separated with hyphens.

Commit messages must follow Conventional Commits.

Examples:

```text
feat: add persistent order history
fix: prevent duplicate receipt numbers
fix(android): recover USB permission device
refactor: separate order state from printing
test: cover partial preparation print failure
docs: update Android setup instructions
chore: separate Android test and production builds
```

Do not commit automatically.

Do not push automatically.

Do not merge automatically.

Do not create or update `main` directly.

At the end of a task, suggest an appropriate branch name and Conventional Commit message when useful.

---

# 17. UI/UX core principles

Samhain POS is not a generic web dashboard.

It is a production tool for fast touchscreen order entry.

Every UI decision should support the cashier.

Before adding a visual element, ask:

> What does this help the cashier do during checkout?

If the answer is primarily:

> It makes the interface look nicer.

reconsider whether it should exist.

Prioritize:

* speed;
* obvious interactions;
* large enough touch targets;
* readability;
* predictable layouts;
* visible primary actions;
* prevention of accidental destructive actions;
* useful information density;
* minimal typing;
* fast recovery from errors.

---

# 18. UI/UX anti-patterns

The following rules are mandatory when designing or modifying the interface.

## 18.1 Avoid generic AI-generated visual style

Do not produce an interface that looks like generic AI-generated SaaS UI.

Avoid gratuitous combinations of:

* blue/purple gradients;
* glassmorphism;
* glowing halos;
* decorative blobs;
* futuristic backgrounds;
* large shadows;
* glow effects;
* AI-startup aesthetics;
* crypto-dashboard aesthetics;
* generic SaaS-dashboard aesthetics.

Every visual decision needs a functional reason.

---

## 18.2 Avoid card inside card inside card

Do not excessively containerize the interface.

Avoid structures like:

```text
card
└── card
    └── panel
        └── card
```

Use:

* spacing;
* alignment;
* typography;
* borders;
* separators;
* surface changes

to create hierarchy.

Product cards are appropriate because products are real interactive units.

This does not mean every piece of information should become a floating card.

---

## 18.3 Do not round everything

Use a small, coherent set of border radii.

Avoid:

* huge border-radius values everywhere;
* pill-shaped panels;
* every label inside a capsule;
* every button looking like a badge.

Pills are acceptable when they represent things such as:

* a status;
* a compact filter;
* a tag;
* a small piece of categorical information.

---

## 18.4 Do not use ambiguous icon-only actions

Important actions must be understandable immediately.

Do not replace a clear label such as:

```text
Annuler
```

with an ambiguous icon.

Icon-only actions are acceptable only for truly obvious conventions or when sufficient context exists.

For critical actions, prefer text, optionally accompanied by an icon.

---

## 18.5 Maintain obvious hierarchy

It must immediately be clear:

* which category is selected;
* which products are tappable;
* which products are already in the order;
* the quantity of each line;
* the current order total;
* the next primary action.

Do not create multiple competing primary CTAs.

`Valider la commande` should visually dominate secondary actions when it is the main next step.

---

## 18.6 Maintain strong contrast

Useful information must be easily readable.

Do not use extremely pale grey text for:

* prices;
* product names;
* quantities;
* totals;
* important instructions.

Do not confuse visual subtlety with poor readability.

---

## 18.7 Avoid unnecessary secondary text

The cashier does not need marketing copy.

Prefer:

```text
Burger spécial Samhain
Steak haché, cheddar, bacon
16,00 €
```

over promotional descriptions.

Only display information that assists ordering or preparation.

---

## 18.8 Avoid oversized decorative headings

Do not dedicate a large part of the screen to headings such as:

```text
Bienvenue sur Samhain POS
```

Do not build hero sections.

Screen space should prioritize:

* products;
* categories;
* the current order;
* totals;
* actions.

---

## 18.9 Avoid wasted space

Whitespace is useful, but this is a POS.

Do not use:

* huge margins;
* excessive vertical gaps;
* extreme padding;
* layouts where very few products are visible without a functional reason.

Balance:

```text
touch comfort
+
information density
```

---

## 18.10 Do not hide frequent actions

Do not hide important frequent actions behind:

* `...` menus;
* hover;
* context menus;
* hamburger menus;
* undocumented gestures.

A touchscreen has no reliable hover.

Frequently used actions should remain visible.

---

## 18.11 Design touchscreen-first

Do not design a desktop UI and adapt it later.

Assume:

* fingers, not mouse cursors;
* no hover;
* fast repeated use;
* accidental taps;
* operator standing;
* high-pressure rush periods.

Interactive targets must be comfortably tappable.

---

## 18.12 Avoid unnecessary dropdowns

For a small set of choices, display the choices directly.

Prefer:

```text
[ Demi 25 cl — 3,50 € ]

[ Pinte 50 cl — 6,00 € ]
```

over:

```text
Taille [ ▼ ]
```

Use dropdowns only when they genuinely improve the interaction.

---

## 18.13 Avoid unnecessary confirmation modals

A simple product should be added immediately when tapped.

Do not create:

```text
Produit ajouté ?
[ Confirmer ]
```

Use a modal or sheet only when a real decision is required.

Example:

```text
Bière
→ Demi or Pinte
```

---

## 18.14 Keep animations functional and short

Animations should communicate state or feedback.

Avoid:

* floating cards;
* slow transitions;
* bouncing interfaces;
* parallax;
* 500 ms menus;
* decorative post-order animations.

Speed takes priority.

Respect reduced-motion preferences.

---

## 18.15 Limit the color palette

Colors should primarily communicate:

* primary action;
* selection;
* state;
* warning/error;
* interface structure.

Do not assign arbitrary different colors to every product.

If categories need differentiation, keep it subtle and systematic.

---

## 18.16 Avoid excessive shadows

Do not make every element appear to float above the interface.

Use primarily:

* spacing;
* alignment;
* typography;
* surfaces;
* borders;
* hierarchy.

If shadows are used, keep them subtle and purposeful.

---

## 18.17 Avoid decorative emojis

Do not automatically add emojis such as:

```text
🍔 🍺 ☕ ✨ 🔥
```

for decoration.

If pictograms are useful, use a coherent icon system.

Do not randomly mix emoji and icons.

---

## 18.18 Avoid badge overload

Do not turn every:

* price;
* quantity;
* category;
* product property

into a pill or badge.

Plain text with good hierarchy is often better.

Use badges only when the representation adds meaning.

---

## 18.19 Avoid redundant information

Do not repeat the same idea multiple times.

Avoid:

```text
COMMANDE
Commande actuelle
Votre commande actuelle
3 produits dans votre commande actuelle
```

Prefer:

```text
Commande
3 articles
```

---

## 18.20 Keep design connected to the business

Do not choose components merely because they look attractive.

Every component should support a real POS task.

If a component exists only for decoration, reconsider it.

---

## 18.21 Do not invent product complexity

Do not add unrelated administrative features to the checkout interface unless requested.

Avoid prematurely adding:

* charts;
* revenue dashboards;
* analytics;
* notifications;
* sophisticated user profiles;
* full administrative sidebars;
* fake settings;
* decorative statistics.

Stay focused on the requested workflow.

---

## 18.22 Avoid long forms during checkout

Minimize keyboard input.

The cashier should be able to perform almost all normal checkout operations through direct touch interactions.

Use free-text input only when it solves a real requirement.

---

## 18.23 Protect destructive actions

Do not give destructive actions exactly the same prominence or placement as the primary action.

For example, avoid putting:

```text
[ Annuler la commande ] [ Valider la commande ]
```

with identical visual treatment.

At the same time, do not bury cancellation so deeply that it becomes impractical.

Balance safety and speed.

---

## 18.24 Avoid desktop-style tables for the cart

Do not default to a dense HTML table for the active order.

Prefer direct touchscreen-friendly list interactions when they work better.

Quantity adjustment, customization and removal should remain easy to operate by touch.

---

## 18.25 Maintain a coherent design system

Keep a deliberately small set of visual rules:

* spacing scale;
* typography sizes;
* primary border radius;
* standard button heights;
* consistent state styles;
* limited palette.

Avoid introducing different arbitrary values in each new component.

Prefer existing project conventions when they are already appropriate.

If the existing UI contains inconsistent values, improve them incrementally rather than rebuilding the entire interface.

---

# 19. Accessibility

Accessibility remains important even for a dedicated POS device.

When modifying UI:

* use semantic HTML where practical;
* ensure interactive elements are keyboard-focusable even if touch is the main input;
* provide accessible names;
* use `aria-pressed`, `aria-live`, dialog semantics and labels appropriately;
* do not rely exclusively on color to communicate important state;
* maintain readable contrast;
* preserve reduced-motion support;
* ensure text remains readable at common tablet sizes.

Do not make accessible interaction significantly worse for aesthetic reasons.

---

# 20. Error handling

Errors should tell the cashier:

1. what happened;
2. whether the order/payment is safe;
3. what action to take next.

Avoid generic errors such as:

```text
Une erreur est survenue.
```

when the application knows more.

Prefer operational messages such as:

```text
Le ticket client a été imprimé, mais le ticket de préparation a échoué.
Vérifiez l'imprimante puis réimprimez uniquement le ticket de préparation.
```

Do not expose technical implementation details to cashiers unless they are useful for recovery.

Technical details may be exposed in a dedicated diagnostic/development view.

---

# 21. Development and production separation

Development tooling must not accidentally become normal production UI.

Examples include:

* mock status controls;
* USB diagnostics;
* printer test actions;
* fake network state;
* debug logs;
* sample data;
* placeholder administrative information.

Keep development features clearly separated.

When adding build-time or runtime development flags:

* make the production behavior safe by default;
* never require developers to remember to manually disable critical test behavior before release.

Production should fail safely when required business or legal configuration is missing.

---

# 22. Performance

This is not an application where advanced micro-optimization is usually necessary.

Optimize for perceived interaction speed.

Avoid introducing noticeable delays in:

* product taps;
* category changes;
* quantity changes;
* option selection;
* opening product configuration;
* checkout.

Do not add unnecessary network round trips to the critical checkout path.

Do not add animations that delay interaction.

---

# 23. Dependencies

Dependencies may be added or updated when they solve a real problem.

Before adding a dependency:

* check whether the platform or existing project already provides the required capability;
* consider maintenance cost;
* consider bundle/native complexity;
* consider whether the problem is small enough to solve locally.

Do not add large dependencies for trivial functionality.

Do not perform broad dependency upgrades unrelated to the current task unless there is a strong security or compatibility reason.

---

# 24. Documentation

Update documentation when a change makes existing documentation materially incorrect.

Especially update documentation when changing:

* setup commands;
* Android workflow;
* native plugin installation;
* build modes;
* production configuration;
* printer behavior;
* persistent storage;
* environment variables.

Do not allow README instructions to knowingly diverge from the actual repository behavior.

---

# 25. Final task report

After implementing a task, provide a concise report containing, as applicable:

* what changed;
* the important files modified;
* noteworthy architectural decisions;
* tests/checks actually executed;
* their results;
* checks that could not be executed;
* required manual Android or printer verification;
* remaining limitations or TODOs;
* a suggested branch name;
* a suggested Conventional Commit message.

Do not claim something was tested when it was only reasoned about.

---

# 26. Core rule

When uncertain between two approaches, prefer the one that makes the POS:

```text
more reliable
→ faster to operate
→ harder to misuse
→ easier to understand
→ easier to maintain
```

Do not optimize Samhain POS to look like a generic modern SaaS application.

Optimize it to work well as a real festival cash register.
