import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(appDir, "build", "icon.svg");

/*
 * `build/icon.icns` é o caminho que o electron-builder procura sozinho, então
 * o empacotamento do M5.3 não precisa apontar nada: basta o arquivo existir
 * versionado. O `.icns` entra no repositório porque a verificação e o pacote
 * dependem dele, e regerar exige macOS.
 */
const target = join(appDir, "build", "icon.icns");

// Cada par é o nome que o iconutil espera e o lado em pixels.
const variants = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

function sips(args) {
  execFileSync("sips", args, { stdio: ["ignore", "ignore", "inherit"] });
}

const work = mkdtempSync(join(tmpdir(), "locum-icon-"));
try {
  /*
   * O sips lê SVG, mas reamostrar vetor dez vezes sai mais lento e sem ganho
   * nenhum: o desenho é de traço reto. Rasteriza uma vez no tamanho maior e
   * reduz a partir do PNG.
   */
  const master = join(work, "master.png");
  sips(["-s", "format", "png", source, "--out", master]);

  const iconset = join(work, "icon.iconset");
  execFileSync("mkdir", ["-p", iconset]);
  for (const [name, side] of variants) {
    const out = join(iconset, name);
    sips(["-z", String(side), String(side), master, "--out", out]);
  }

  execFileSync("iconutil", ["-c", "icns", iconset, "-o", target], {
    stdio: "inherit",
  });
  console.log(`icone gerado em ${target}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
