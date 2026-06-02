const path = require("node:path");

// pluginId が npm package 名でないため "textlint-plugin-<id>" の解決には失敗するが、
// その後段で textlint module-resolver が require.resolve(<id>) を試すため、
// 絶対パスを渡せばローカル plugin として読み込まれる。
// ここではリポジトリ直下の bundle 済み index.js を直接参照する。
const yamlKeysPlugin = path.join(__dirname, "..", "index.js");

module.exports = {
  plugins: {
    [yamlKeysPlugin]: {
      keys: ["description"],
    },
  },
  filters: {},
  rules: {
    "no-todo": true,
  },
};
