import fs from "fs";
import path from "path";
import type { MergeLensConfig } from "@corrdex/shared/contracts/analysis.js";

const CONFIG_FILE_NAMES = ["corrdex.config.json", "mergelens.config.json"];

const DEFAULT_CONFIG: MergeLensConfig = {
    rules: {
        "no-external-api-in-controller": "error",
    },
};

export function loadConfig(cwd: string): MergeLensConfig {
    try {
        for (const fileName of CONFIG_FILE_NAMES) {
            const configPath = path.join(cwd, fileName);
            if (!fs.existsSync(configPath)) {
                continue;
            }

            const fileContent = fs.readFileSync(configPath, "utf-8");
            const userConfig = JSON.parse(fileContent);

            return {
                rules: {
                    ...DEFAULT_CONFIG.rules,
                    ...(userConfig.rules || {}),
                },
            };
        }
    } catch (e) {
        console.error("Failed to parse Corrdex config, falling back to defaults.", e);
    }

    return DEFAULT_CONFIG;
}
