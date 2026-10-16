// Eagerly pull the workspace core module into the web import graph so the
// boot-preloaded `workspace.catalog` live value self-registers before first
// paint (boot-snapshot resolves every preloaded key to its descriptor then).
// Its readers — the Workspace launch option's pill and select — mount on
// demand, so the eager registration is anchored here, with the value's owner.
import "@plugins/conversations/plugins/workspace/core";
