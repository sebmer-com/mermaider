import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

let css: Promise<string> | undefined;
/** Embed the approved, unmodified font assets so a saved gallery remains offline. */
export function brandFonts(): Promise<string> {
  if (!css) {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../assets/fonts",
    );
    css = Promise.all([
      fs.readFile(path.join(root, "LM-regular.woff2")),
      fs.readFile(path.join(root, "LM-italic.woff2")),
      fs.readFile(path.join(root, "FONT-LICENSE.txt"), "utf8"),
    ]).then(
      ([regular, italic, license]) =>
        `/* ${license.replace(/\*\//g, "* /").replace(/<\/style/gi, "<\\/style")} */\n` +
        `@font-face{font-family:"Latin Modern";src:url(data:font/woff2;base64,${regular.toString("base64")}) format("woff2");font-weight:400;font-style:normal;font-display:swap}\n` +
        `@font-face{font-family:"Latin Modern";src:url(data:font/woff2;base64,${italic.toString("base64")}) format("woff2");font-weight:400;font-style:italic;font-display:swap}`,
    );
  }
  return css;
}
