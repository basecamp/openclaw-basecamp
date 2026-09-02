/**
 * Derived SDK adapter types.
 *
 * OpenClaw 2.0 exports `ChannelPlugin` from `openclaw/plugin-sdk/channel-core`
 * but several adapter types have no typed subpath export of their own. Derive
 * them from the `ChannelPlugin` shape here so the rest of the codebase has a
 * single import site (SPEC §1.1).
 */

import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";

export type ChannelGroupAdapter = NonNullable<ChannelPlugin["groups"]>;
export type ChannelHeartbeatAdapter = NonNullable<ChannelPlugin["heartbeat"]>;
export type ChannelMentionAdapter = NonNullable<ChannelPlugin["mentions"]>;
export type ChannelResolverAdapter = NonNullable<ChannelPlugin["resolver"]>;
export type ChannelMessagingAdapter = NonNullable<ChannelPlugin["messaging"]>;
export type ChannelAgentPromptAdapter = NonNullable<ChannelPlugin["agentPrompt"]>;
export type ChannelOwnedSetupContract = NonNullable<ChannelPlugin["setupContract"]>;
export type ChannelLifecycleAdapter = NonNullable<ChannelPlugin["lifecycle"]>;

export type ChannelPairingAdapter = NonNullable<ChannelPlugin["pairing"]>;
export type ChannelDoctorAdapter = NonNullable<ChannelPlugin["doctor"]>;
export type ChannelSecretsAdapter = NonNullable<ChannelPlugin["secrets"]>;

export type ChannelSecurityAdapter<ResolvedAccount = unknown> = NonNullable<ChannelPlugin<ResolvedAccount>["security"]>;
export type ChannelSecurityDmPolicy<ResolvedAccount = unknown> = NonNullable<
  ReturnType<NonNullable<ChannelSecurityAdapter<ResolvedAccount>["resolveDmPolicy"]>>
>;
export type SecurityAuditFinding = Awaited<
  ReturnType<NonNullable<ChannelSecurityAdapter["collectAuditFindings"]>>
>[number];

export type ChannelConfiguredBindingProvider = NonNullable<ChannelPlugin["bindings"]>;
