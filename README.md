# textlint-plugin-yaml-keys

YAML の指定したキーの値を抽出し、textlint のルール
(`textlint-rule-preset-ja-technical-writing` など) を YAML の値に適用できるように
する textlint プラグイン。

deno で開発し、npm / JSR には publish しない。bundle 済みの `dist/index.js`
(依存の `yaml` を同梱) を git にコミットし、[jsDelivr](https://www.jsdelivr.com/)
の gh エンドポイント経由で配信する。

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

Node の `require` は URL を解決できないため、jsDelivr の URL を `.textlintrc`
に直接書くことはできない。`dist/index.js` をローカルへ取得し、絶対パスで参照する。
`dist/index.js` は ESM なので、Node 側は `require` で ESM を読み込める
(require(esm) 対応の) バージョンが必要になる。

```sh
curl -fsSL https://cdn.jsdelivr.net/gh/ansanloms/textlint-plugin-yaml-keys@0.0.3/dist/index.js \
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

deno は URL import を解決できるため、jsDelivr の URL から直接読み込める。

```ts
import { TextlintKernel } from "npm:@textlint/kernel";
import plugin from "https://cdn.jsdelivr.net/gh/ansanloms/textlint-plugin-yaml-keys@0.0.3/dist/index.js";

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

> [!NOTE]
> jsDelivr の gh エンドポイントはタグ固定 (`@0.0.3` など) を推奨する。
> `@main` などのブランチ参照は最大 12 時間 CDN にキャッシュされる。
> `dist/index.js` は `0.0.3` 以降のタグにのみ存在する。

## 開発

```sh
deno task test    # テスト (coverage 付き)
deno task check   # 型チェック
deno task lint    # deno lint && deno fmt --check
deno task fix     # deno lint --fix && deno fmt
deno task build   # deno bundle で dist/index.js を生成
```

外部依存は `deno.json` の `imports` で管理する。Dependabot が `deno.json` と
`deno.lock` を更新する。

`dist/index.js` は `index.ts` から `deno bundle --platform=browser --minify` で
生成した配信用成果物 (`yaml` 同梱)。browser platform で bundle するのは `node:`
依存の shim を含めず、https 経由で deno から import できるようにするため。
`--minify` を付けるのはサイズ削減に加え、非 minify 出力ではバンドラがモジュール境界の
ラベルとしてビルドマシンの deno キャッシュへのパスを埋め込むのに対し、minify 出力では
そのラベル自体が生成されず、マシン依存のパスが成果物に混入しないため。`index.ts`
を変更したら `deno task build` で再生成してコミットする。CI がコミット済みの
`dist/index.js` とソースの一致を検査する。

依存の更新でも bundle の内容は変わるため、Dependabot の PR はこの検査で失敗する。
その場合は PR のブランチで `deno task build` を実行し、`dist/index.js` をコミットして
push する。`deno bundle` の出力は Deno のバージョンで変わりうるので、再生成には
CI と同じ Deno (`.github/workflows/ci.yml` の `deno-version`) を使う。

> [!NOTE]
> `deno bundle` は現状 experimental (`subject to changes` の警告が出る)。

### リリース手順

1. `deno.json` の `version` を更新し `deno task build` で `dist/index.js` を
   再生成してコミットする。
2. 同じ値でタグを打って push する。GitHub Release は作らない
   (jsDelivr は git のタグを参照する)。

## ライセンス

MIT
