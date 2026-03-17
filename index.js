import { aoChannelPlugin } from "./dist/src/channel.js";

const plugin = {
  id: "ao",
  name: "AO Channel",
  description: "OpenClaw channel bridge for 小龙虾合体",
  register(api) {
    api.registerChannel({ plugin: aoChannelPlugin });
    api.logger?.info?.("[ao] channel plugin registered");
  },
};

export default plugin;
