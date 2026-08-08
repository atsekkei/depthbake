#!/usr/bin/env node
import { Command } from "commander";
import { runBake } from "./bake.ts";
import { formatInspectionHuman, inspectPackage, validatePackages } from "./package.ts";

const program = new Command();
program.name("photospace").description("Photospace CLI — 深度推定パッケージの一括ベイク");

program
  .command("bake")
  .description("写真候補とdepth.png/meta.json(+オプションのmask/normal)を含むパッケージを一括生成する")
  .argument("<patterns...>", "入力画像のパス・globパターン・ディレクトリ")
  .option("--config <path>", "photospace.config.json のパス")
  .option("--out <dir>", "出力先ディレクトリ", "out")
  .option("--mask", "mask.png(空マスク+エッジマスク)を同梱する")
  .option("--normal", "normal.png(ワールド法線)を同梱する")
  .option("--force", "source hashが一致しても再ベイクする")
  .option("--dry-run", "入力・出力先・設定を解決し、モデルを読み込まずに終了する")
  .option("--json", "機械可読JSONだけをstdoutへ出力する")
  .option("--quiet", "通常の進捗出力を抑制する")
  .action(async (patterns: string[], options: { config?: string; out: string; mask?: boolean; normal?: boolean; force?: boolean; dryRun?: boolean; json?: boolean; quiet?: boolean }) => {
    const result = await runBake(patterns, options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    if (result.failed > 0) process.exitCode = 1;
  });

program
  .command("validate")
  .description("Photospace package のファイルとmeta.json整合性を検証する")
  .argument("<packages...>", "検証する package directory")
  .option("--max-bytes <bytes>", "package size budget", (value) => Number.parseInt(value, 10))
  .option("--json", "機械可読JSONだけをstdoutへ出力する")
  .action(async (packages: string[], options: { maxBytes?: number; json?: boolean }) => {
    const results = await validatePackages(packages, { maxBytes: options.maxBytes });
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ valid: results.every((result) => result.valid), packages: results }, null, 2)}\n`);
    } else {
      for (const result of results) {
        const line = result.valid ? `OK    ${result.path}` : `FAIL  ${result.path}`;
        (result.valid ? console.log : console.error)(line);
        for (const error of result.errors) console.error(`      ${error}`);
      }
    }
    if (results.some((result) => !result.valid)) process.exitCode = 1;
  });

program
  .command("inspect")
  .description("Photospace package の要約を表示する")
  .argument("<package>", "inspectする package directory")
  .option("--json", "機械可読JSONだけをstdoutへ出力する")
  .action(async (packagePath: string, options: { json?: boolean }) => {
    const result = await inspectPackage(packagePath);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      console.log(formatInspectionHuman(result));
    }
    if (!result.valid) process.exitCode = 1;
  });

program.parseAsync(process.argv);
