import { getConfig } from "@plugins/config_v2/server";
import {
  AnalysisDeviceSchema,
  AnalysisSettingsSchema,
  type AnalysisDevice,
  type AnalysisSettings,
} from "../../core";
import { audioAnalysisConfig } from "../../shared/config";

/**
 * The configured analysis: the settings that key the cache, and the device.
 * An in-memory config read, so cheap on a request path. The enum fields read
 * back as strings; parsed, so a hand-edited value fails loudly.
 */
export function configuredAnalysis(): {
  settings: AnalysisSettings;
  device: AnalysisDevice;
} {
  const config = getConfig(audioAnalysisConfig);
  return {
    settings: AnalysisSettingsSchema.parse({
      beatModel: config.beatModel,
      chroma: config.chroma,
    }),
    device: AnalysisDeviceSchema.parse(config.device),
  };
}
