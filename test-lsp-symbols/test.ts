import { lsp_symbols } from "../src/lsp";
import { setPluginInput } from "../src/shared/plugin-context";

setPluginInput({} as any);

async function main() {
  const result = await lsp_symbols.execute({
    filePath: "./index.ts",
    scope: "workspace",
    query: "cloneDeep"
  }, {});
  console.log(result);
}

main();
