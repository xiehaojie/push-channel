
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { pushChannelPlugin } from "./src/channel.js";
import { setPushChannelRuntime } from "./src/runtime.js";

export default {
    id: "push-channel",
    name: "Push Channel",
    register(api: OpenClawPluginApi) {
        setPushChannelRuntime(api.runtime);
        api.registerChannel({ plugin: pushChannelPlugin });
    }
};
