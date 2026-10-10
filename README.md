# textlint-plugin-yaml-keys

YAML の指定したキーの値を抽出し、textlint のルール
(`textlint-rule-preset-ja-technical-writing` など) を YAML の値に適用できるように
する textlint プラグイン。

npm には publish せず、GitHub のタグを git 依存で参照する。

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

インストール (タグ固定を推奨する):

```sh
npm install -D github:ansanloms/textlint-plugin-yaml-keys#0.1.0
```

`.textlintrc.js`:

```js
module.exports = {
  plugins: {
    "@ansanloms/textlint-plugin-yaml-keys": {
      keys: ["description"],
    },
  },
  rules: {
    // 任意の textlint ルール
  },
};
```

> [!NOTE]
> 配布物は ESM。textlint v13 以降が ESM の plugin を読める。

## 開発

```sh
npm ci            # 依存のインストール
npm test          # テスト
npm run check     # 型チェック
npm run lint      # oxlint && oxfmt --check
npm run fix       # oxlint --fix && oxfmt
npm run compile   # tsc で dist/ を生成
```

`dist/` は tsc の出力で、git にコミットして配布する。`index.ts` を変更したら
`npm run compile` を実行してコミットする。CI がコミット済みの `dist/` とソースの一致を
検査する。`yaml` は同梱していないため、その更新で `dist/` は変わらない。`typescript` の
更新では出力が変わることがあり、その Dependabot PR で dist の鮮度検査が落ちたら PR
ブランチで `npm run compile` を実行して `dist/` をコミットする。

依存は正確な版で固定し (`.npmrc` の `save-exact`)、更新は Dependabot の PR で取り込む。
`ignore-scripts` で install 時に依存の lifecycle script を実行しない (`npm run` の本体 script には影響しない)。`min-release-age` で公開から 7 日未満の版を新規に解決しない (lockfile に固定済みの版には効かない)。

Node 24 は開発環境の要件 (`.node-version`) で、配布物は素の ESM なので利用側に Node 24 を要求しない。

examples は `file:..` でこの repo を symlink 参照し、`yaml` をルートの `node_modules`
から解決する。examples を動かす前にルートで `npm ci` を実行する。

`package.json` の scripts に `build` / `prepare` 等を置かない。npm は git 依存の
install 時にこれらがあると依存側でビルドを走らせるため。

### リリース手順

1. `npm version <version> --no-git-tag-version` で `package.json` と
   `package-lock.json` を更新し、`cd examples && npm install` で
   `examples/package-lock.json` も更新し、`npm run compile` して全部コミットする。
2. 同じ値でタグを打って push する。GitHub Release は作らない。

## ライセンス

MIT
