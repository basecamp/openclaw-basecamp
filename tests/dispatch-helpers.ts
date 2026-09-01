/**
 * Shared fixtures for the dispatch trio (SPEC §4.4).
 *
 * The turn-kernel dispatch tests exercise the real
 * `buildChannelInboundEventContext` and the real ingress resolver; only
 * `runtime.channel.inbound.run` is replaced by a minimal fake kernel that
 * drives ingest → classify → preflight → resolveTurn with the same admission
 * semantics as `runChannelTurn`, capturing the resolved plans so tests can
 * inspect the context payload and drive the delivery adapter.
 */

import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { vi } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: test double over SDK shapes
type Any = any;

export type FakeKernel = {
  runtime: Any;
  /** Resolved turn plans, in dispatch order. */
  plans: Any[];
  /** Turn results (both drops and dispatches), in order. */
  results: Any[];
  /** Deliver this text through each subsequently dispatched plan's delivery adapter. */
  setAgentReply(text: string | undefined): void;
  lastPlan(): Any;
  lastCtx(): Any;
  lastResult(): Any;
};

function isAdmission(value: unknown): value is { kind: string; reason?: string } {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "dispatch" || kind === "observeOnly" || kind === "handled" || kind === "drop";
}

/** Build a mock plugin runtime whose inbound.run is a faithful mini-kernel. */
export function createFakeKernel(): FakeKernel {
  const plans: Any[] = [];
  const results: Any[] = [];
  let agentReply: string | undefined;

  const run = vi.fn(async ({ raw, adapter }: Any) => {
    const finish = (result: Any) => {
      results.push(result);
      return result;
    };

    const input = await adapter.ingest(raw);
    if (!input) return finish({ admission: { kind: "drop", reason: "ingest-null" }, dispatched: false });

    const eventClass = (await adapter.classify?.(input)) ?? { kind: "message", canStartAgentTurn: true };
    if (!eventClass.canStartAgentTurn) {
      return finish({ admission: { kind: "handled", reason: `event:${eventClass.kind}` }, dispatched: false });
    }

    const rawPreflight = await adapter.preflight?.(input, eventClass);
    const preflight = isAdmission(rawPreflight) ? { admission: rawPreflight } : (rawPreflight ?? {});
    if (preflight.admission && preflight.admission.kind !== "dispatch" && preflight.admission.kind !== "observeOnly") {
      return finish({ admission: preflight.admission, dispatched: false });
    }

    const plan = await adapter.resolveTurn(input, eventClass, preflight);
    plans.push(plan);

    if (agentReply !== undefined) {
      try {
        await plan.delivery.deliver({ text: agentReply }, {});
      } catch (err) {
        plan.delivery.onError?.(err, { kind: "final" });
      }
    }

    return finish({
      admission: plan.admission ?? { kind: "dispatch" },
      dispatched: true,
      ctxPayload: plan.ctxPayload,
      routeSessionKey: plan.route.sessionKey,
      dispatchResult: {},
    });
  });

  const runtime = {
    channel: {
      routing: { resolveAgentRoute: vi.fn() },
      inbound: { buildContext: vi.fn((params: Any) => buildChannelInboundEventContext(params)), run },
      pairing: {
        readAllowFromStore: vi.fn(async () => [] as string[]),
        upsertPairingRequest: vi.fn(async () => ({ code: "PAIR-123", created: true })),
      },
    },
  };

  return {
    runtime,
    plans,
    results,
    setAgentReply: (text) => {
      agentReply = text;
    },
    lastPlan: () => plans[plans.length - 1],
    lastCtx: () => plans[plans.length - 1]?.ctxPayload,
    lastResult: () => results[results.length - 1],
  };
}
