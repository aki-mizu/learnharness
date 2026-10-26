"use client";

/** Client-side thinking assignment mirrors the engine: custom endpoints
 * default to xhigh and keep only an explicit medium choice; built-in
 * models use DEFAULT_THINKING_ORDER for first assignment and preserve
 * explicit picks for server-side clamping after a model swap. */
import { DEFAULT_THINKING_ORDER } from "@/src/core";
import { CUSTOM_DEFAULT_THINKING_LEVEL, customThinkingLevel, isCustomProviderId } from "@/src/core/custom-providers";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** Display labels for the levels (shared by every trigger that shows
 *  one). Lowercase, always (owner refinement round, 2026-09-24): the
 *  level strings ARE the display form — the settings menus render them
 *  raw, so the composer pill and setup dialog must match, never Title
 *  Case. */
export const THINKING_LABEL: Record<string, string> = {
	off: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

/** A custom endpoint starts at xhigh. Built-in models use the first
 *  supported entry in the default order, with off as the empty fallback. */
export function defaultOrderLevel(supported: readonly ThinkingLevel[], provider?: string): ThinkingLevel {
	if (isCustomProviderId(provider ?? "")) return CUSTOM_DEFAULT_THINKING_LEVEL;
	for (const level of DEFAULT_THINKING_ORDER) {
		if (supported.includes(level)) return level;
	}
	return supported[0] ?? "off";
}

/** Custom endpoints keep medium or use xhigh, including when switching
 *  from a built-in model with a different level. For built-in models an
 *  EXPLICIT level always rides — even when the fresh pick's model
 *  doesn't support it: the WRITE clamps it to the nearest supported level
 *  server-side (Platform's interlude bd68486 — the owner's swap-400 case
 *  now just works), and the cross-surface signal re-reads so the clamped
 *  truth displays. The ordering only assigns FIRST: when no explicit
 *  level exists, a fresh model pick populates the ordering's level for
 *  that model (chunk 2: the unset state can never re-enter). */
export function populateLevel(
	explicit: ThinkingLevel | undefined,
	supported: readonly ThinkingLevel[],
	provider?: string,
): ThinkingLevel {
	if (isCustomProviderId(provider ?? "")) return customThinkingLevel(explicit);
	return explicit ?? defaultOrderLevel(supported, provider);
}
