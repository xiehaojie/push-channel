
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
import type { PluginRuntime } from "openclaw/plugin-sdk";

const { setRuntime: setPushChannelRuntime, getRuntime: getPushChannelRuntime } =
  createPluginRuntimeStore<PluginRuntime>("PushChannel runtime not initialized");

export { getPushChannelRuntime, setPushChannelRuntime };
