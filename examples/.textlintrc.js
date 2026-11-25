module.exports = {
  plugins: {
    "@ansanloms/textlint-plugin-yaml-keys": {
      files: [{ keys: ["description"] }],
    },
  },
  filters: {},
  rules: {
    "no-todo": true,
  },
};
