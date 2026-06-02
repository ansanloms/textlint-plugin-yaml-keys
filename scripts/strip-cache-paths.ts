// deno bundle が出力する index.js には、ビルドマシンの deno キャッシュへの
// 相対パス (例: ../../../../.cache/deno/npm/registry.npmjs.org/yaml/2.9.0/...) が
// コメントおよび __commonJS のキーとして多数埋め込まれる。
//
// これらはバンドラが付与するモジュール境界ラベルにすぎない。__commonJS は
// 渡されたオブジェクトの「最初のプロパティ」を位置で参照する (キー名は不問) ため、
// 文字列を書き換えても実行時の意味論は変わらない。
//
// マシン依存かつ非再現的なパス漏洩を防ぐため、ビルド後にこれらのラベルを
// 中立な連番 (module_0, module_1, ...) へ置換する。

const target = new URL("../index.js", import.meta.url);
const original = Deno.readTextFileSync(target);

// (../)+ .cache/deno/ で始まるモジュールパスのトークン。
// コメント行ではクォート・空白で、__commonJS のキーではクォートで終端する。
const pathPattern = /(?:\.\.\/)+\.cache\/deno\/[^\s"]*/g;

// 出現順に distinct なパスへ連番ラベルを割り当てる。
const labels = new Map<string, string>();
for (const match of original.matchAll(pathPattern)) {
  if (!labels.has(match[0])) {
    labels.set(match[0], `module_${labels.size}`);
  }
}

// トークン単位で丸ごと差し替える (接頭辞被りによる部分破壊を避ける)。
const replaced = original.replace(
  pathPattern,
  (token) => labels.get(token) ?? token,
);

// 漏洩検知: 想定外の依存・キャッシュ参照が残っていれば build を失敗させる。
const leakPattern = /\.cache\/deno|registry\.npmjs\.org/;
if (leakPattern.test(replaced)) {
  console.error(
    "strip-cache-paths: キャッシュパスが残存している。pathPattern を見直すこと。",
  );
  Deno.exit(1);
}

if (replaced === original) {
  console.log("strip-cache-paths: 置換対象なし。");
} else {
  Deno.writeTextFileSync(target, replaced);
  console.log(
    `strip-cache-paths: ${labels.size} 個のモジュールラベルを置換した。`,
  );
}
