@AGENTS.md

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## This Fork

This is a fork of `moeru-ai/airi` being customized to integrate **Claude Code** (Anthropic's CLI) into Airi's chat window. See `PLAN.md` at the repo root for the live implementation plan, progress dashboard, and working log. When picking up work, start by reading `PLAN.md` to find the current Phase and next unchecked task. Update the phase status, checkboxes, and 実績ログ sections as you go.

## OC-Features (Agent Runtime)

Running alongside the Claude Code integration is the **agent runtime** (`OC-AG-*` phases in `PLAN.md`). Related code lives under:

- `packages/agent-runtime` — platform-agnostic harness core (`createAgentHarness`, `runAttempt`, `handleToolCall`, `evaluateSensitivity`, `createInteractiveApprovalGate`).
- `packages/skill-registry` — SKILL.md loader + trigger-based registry.
- `packages/cron-runtime` — single-timer reschedule scheduler (`createCronScheduler`, `createJsonJobStore`, `createFakeClock`).
- `apps/stage-tamagotchi/src/main/services/airi/{agent,skills,cron}` — main-process wiring (Option A: main owns persistence + scheduling, renderer owns turn execution).
- `packages/stage-ui/src/stores/modules/agent-runtime.ts` — renderer Pinia store driving `dispatchTurn`, approvals, and IPC to the main service.
- `apps/stage-tamagotchi/src/renderer/components/agent/approval-modal.vue` + `composables/agent-approval.ts` — user-facing approval modal.

Integration guides: `docs/integrations/agent-runtime.md` (architecture), `docs/integrations/skill-authoring-guide.md` (SKILL.md), `docs/integrations/agent-runtime-security.md` (sensitivity + approval + allow-list). Opt-in integration test: `apps/stage-tamagotchi/test/integration/agent-runtime.test.ts` (gated by `AIRI_TEST_AGENT_RUNTIME=1`).
