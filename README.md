# textlint-plugin-yaml-keys

YAML の指定したキーの値を抽出し、textlint のルール
(`textlint-rule-preset-ja-technical-writing` など) を YAML の値に適用できるように
する textlint プラグイン。

npm には publish せず、GitHub のタグを git 依存で参照する。

## 仕組み

textlint の `Processor` プラグインとして動作する。`preProcess` で YAML をパースし、
指定キーにマッチするスカラ値を `Str` ノードとして持つ AST
を組み立てる。既定では値を Markdown として解釈した AST (`Document > Paragraph > Str` など) になり、`markdown: false` の場合は
`Document > Paragraph > Str` だけの AST になる。これにより textlint の各ルールが YAML の値テキストに対して働く。既定ではインラインコード、コードブロック、Html などの Markdown の要素はチェック対象から外れる (`markdown` オプションの節を参照)。

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
  - block scalar は行ごとに別の Str ノードへ分割する。Str にインデントと
    末尾改行は含めない。textlint の fix が行頭の空白を消して YAML を壊さない
    ようにするため。
- quoted scalar (`"..."`): fix の安全性を保証できないため除外する。

## `markdown` オプション

既定は `true` で、抽出した値を Markdown として解釈して AST を組み立てる。`false` にすると値をプレーンテキストとして扱い、行ごとの Str だけを組み立てる。

- インラインコードとコードブロックは、`.md` と同じくチェック対象から外れる。ルールが `--fix` でコードの中身を書き換えることもない。
- コードの前後のスペースを見るルール (`ja-space-around-code` など) が適用される。
- `1. foo` のような値はリストとして解釈される。引用 (`>`) やリストのマーカーは Str に含めない。
- block scalar のインデントは除いて解釈する。Str の range は源文上の位置を指す。
- Markdown のパースには `@textlint/markdown-to-ast` を使う。版は textlint の版に合わせる。

プレーンテキストの値を Markdown として読むと、`<...>` は Html、`1. ` で始まる行は List、`*` や `_` は強調として解釈される。これらの部分はチェック対象から外れる。この解釈で値が書き換わることはない。抽出するキーの中にこうした値がある場合は `markdown: false` を指定する。このオプションは `keys` に指定した全てのキーに一括で適用され、キーごとには切り替えられない。

```js
module.exports = {
  plugins: {
    "@ansanloms/textlint-plugin-yaml-keys": {
      keys: ["description"],
    },
  },
};
```

プレーンテキストとして扱う場合:

```js
module.exports = {
  plugins: {
    "@ansanloms/textlint-plugin-yaml-keys": {
      keys: ["description"],
      markdown: false,
    },
  },
};
```

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
npm run clean     # dist/ を削除
npm run compile   # clean の後に tsc で dist/ を生成し直す
```

`dist/` は tsc の出力で、git にコミットして配布する。`index.ts` を変更したら
`npm run compile` を実行してコミットする。CI がコミット済みの `dist/` とソースの一致を
検査する。`yaml` は同梱していないため、その更新で `dist/` は変わらない。`typescript` の
更新では出力が変わることがあり、その Dependabot PR で dist の鮮度検査が落ちたら PR
ブランチで `npm run compile` を実行して `dist/` をコミットする。

依存は正確な版で固定し (`.npmrc` の `save-exact`)、更新は Dependabot の PR で取り込む。
`ignore-scripts` で install 時に依存の lifecycle script を実行しない (`npm run` の本体 script には影響しない)。`min-release-age` で公開から 7 日未満の版を新規に解決しない (lockfile に固定済みの版には効かない)。

Node 24 は開発環境の要件 (`.node-version`) で、配布物は素の ESM なので利用側に Node 24 を要求しない。

examples はこの package を依存に載せない。動かすにはルートで `npm ci` を実行し、
examples で `npm ci && npm install --no-save ..` を実行してこの repo を symlink
で入れる。`yaml` はルートの `node_modules` から解決する。後から examples で
`npm install` を実行すると symlink が消えるため、その後は `npm install --no-save ..`
を再度実行する。

`package.json` の scripts に `build` / `prepare` 等を置かない。npm は git 依存の
install 時にこれらがあると依存側でビルドを走らせるため。

### リリース手順

1. `npm version <version> --no-git-tag-version` で `package.json` と
   `package-lock.json` を更新し、`npm run compile` して全部コミットする。
2. 同じ値でタグを打って push する。GitHub Release は作らない。

## ライセンス

MIT
