
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setPushChannelRuntime, getRuntime: getPushChannelRuntime } =
  createPluginRuntimeStore<PluginRuntime>("PushChannel runtime not initialized");

export { getPushChannelRuntime, setPushChannelRuntime };
