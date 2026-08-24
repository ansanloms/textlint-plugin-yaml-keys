# textlint-plugin-yaml-keys

YAML の指定したキーの値を抽出し、textlint のルール
(`textlint-rule-preset-ja-technical-writing` など) を YAML の値に適用できるように
する textlint プラグイン。

deno で開発し、npm / JSR には publish しない。bundle 済みの `index.js`
(依存の `yaml` を同梱) を GitHub Release の asset として配布する。

## 仕組み

textlint の `Processor` プラグインとして動作する。`preProcess` で YAML をパースし、
指定キーにマッチするスカラ値を `Str` ノードとして持つ AST
(`Document > Paragraph > Str`) を組み立てる。これにより textlint の各ルールが
YAML の値テキストに対して働く。

対応拡張子は `.yaml` / `.yml`。

## `keys` オプション

抽出対象の YAML キーを文字列の配列で指定する。

| 記法           | 説明                     | 例              |
| -------------- | ------------------------ | --------------- |
| ドット無しキー | 任意の深さに再帰マッチ   | `description`   |
| ドット付きパス | ルートからの完全一致のみ | `a.b`           |
| `*`            | 任意のキー 1 段にマッチ  | `*.description` |
| `[]`           | 配列要素にマッチ         | `list[].name`   |

### 抽出対象のスカラ

- plain scalar / block scalar (`|-` など): 抽出する。
  - block scalar は textlint の fix が源文座標を壊さないよう、生ソースを
    インデント込み・末尾改行除外で採取する。
- quoted scalar (`"..."`): fix の安全性を保証できないため除外する。

## 利用

### Node の textlint から使う

Release asset の `index.js` をローカルへ取得し、絶対パスで参照する。

```sh
curl -fsSL https://github.com/ansanloms/textlint-plugin-yaml-keys/releases/download/0.0.2/index.js \
  -o textlint-plugin-yaml-keys.js
```

`.textlintrc.js`:

```js
const path = require("node:path");

// pluginId が npm package 名でないため "textlint-plugin-<id>" の解決には失敗するが、
// その後段で textlint module-resolver が require.resolve(<id>) を試すため、
// 絶対パスを渡せばローカル plugin として読み込まれる。
const yamlKeysPlugin = path.join(__dirname, "textlint-plugin-yaml-keys.js");

module.exports = {
  plugins: {
    [yamlKeysPlugin]: {
      keys: ["description"],
    },
  },
  rules: {
    // 任意の textlint ルール
  },
};
```

### deno の `@textlint/kernel` から使う

Release asset の `index.js` をローカルへ取得し、相対 import する。

```sh
curl -fsSL https://github.com/ansanloms/textlint-plugin-yaml-keys/releases/download/0.0.2/index.js \
  -o textlint-plugin-yaml-keys.js
```

```ts
import { TextlintKernel } from "npm:@textlint/kernel";
import plugin from "./textlint-plugin-yaml-keys.js";

const kernel = new TextlintKernel();
const result = await kernel.lintText("description: hello world\n", {
  ext: ".yaml",
  plugins: [
    {
      pluginId: "yaml-keys",
      plugin,
      options: { keys: ["description"] },
    },
  ],
  rules: [
    // 任意の textlint ルール
  ],
});
```

## 開発

```sh
deno task test    # テスト (coverage 付き)
deno task check   # 型チェック
deno task lint    # deno lint && deno fmt --check
deno task fix     # deno lint --fix && deno fmt
deno task build   # deno bundle で index.js を生成
```

外部依存は `deno.json` の `imports` で管理する。Dependabot が `deno.json` と
`deno.lock` を更新する。

`index.js` は git 管理せず、Release 公開時に GitHub Actions が
`deno task build` で生成して asset として添付する。ローカルで `examples/` を
動かすときは先に `deno task build` を実行する。

> [!NOTE]
> `deno bundle` は現状 experimental (`subject to changes` の警告が出る)。

### リリース手順

1. `deno.json` の `version` を更新してコミットする。
2. 同じ値でタグを打って push する。
3. `gh release create <tag> --verify-tag --generate-notes` で Release を公開すると
   `release.yml` が `index.js` を添付する。

既存のタグに後から Release を作る場合は、Release 作成後に
`gh workflow run release.yml --ref main -f tag=<tag>` で asset を添付する
(タグ時点にワークフローファイルが無いため `release` イベントでは起動しない)。

## ライセンス

MIT
