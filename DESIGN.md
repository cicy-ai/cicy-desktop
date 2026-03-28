# CiCy Desktop Design

## Product Thesis

CiCy Desktop is not a generic admin panel.
It is a runtime cockpit for a desktop automation node.

The UI should answer three operator questions:

1. What is the node doing right now?
2. What session or profile am I acting on?
3. What is the next action I want to take?

Everything else is secondary.

## Core Model

The product has two runtimes:

- Electron sessions
- Chrome profiles

Both runtimes follow the same operator loop:

1. `Operate`
   Focus the current thing.
   Example: live preview, current profile state.
2. `Launch`
   Start or switch to a target.
   Example: open ChatGPT, open a profile.
3. `Tune`
   Configure, inspect, or do destructive actions.
   Example: bounds, capture settings, proxy, close all.

The main screen should show only one of these loops at a time.

## Layout Rules

- Left rail: identity + runtime switch + session/profile selection.
- Main stage: one dominant task surface only.
- No permanent debug sidebars.
- No explanatory paragraphs in the main operating surface.
- Advanced controls belong in `Tune`, not next to the live workspace.

## Interaction Principles

- Default landing state is `Operate`.
- Switching runtime resets the workspace mode to `Operate`.
- Selection should be sticky across refreshes.
- Dangerous actions must be visually separated and confirmation-backed.
- Keyboard forwarding must only happen in live operation mode, never while editing local inputs.

## Visual Direction

- Dark industrial control-room aesthetic, not SaaS dashboard chrome.
- One restrained accent color.
- Large stage, low copy density, high information contrast.
- Rounded panels are acceptable, but panel count should stay low.
- Motion should only reinforce state change, never decorate.

## Anti-Patterns

- Do not put all controls on screen at once.
- Do not mix launch, observe, and configure in one canvas.
- Do not use marketing copy inside the operator workspace.
- Do not make Chrome and Electron feel like unrelated products.
