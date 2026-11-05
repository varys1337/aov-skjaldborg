import { runLegacyCommand } from "./lib/legacy-cli.mjs";
const args = process.argv.slice(2);
if (args[0]) args[0] = args[0].replace(/^v/, "");
runLegacyCommand("set-version", args);
