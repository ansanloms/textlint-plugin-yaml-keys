import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "./index.ts";

const { Processor } = plugin;

interface Str {
  type: string;
  value: string;
  range: [number, number];
  loc: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}

interface Ast {
  type: string;
  range: [number, number];
  loc: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  children: Array<{ type: string; children: Str[] }>;
}

function preProcess(text: string, keys?: string[]): Ast {
  const p = new Processor(keys ? { keys } : {});
  return p.processor(".yaml").preProcess(text) as unknown as Ast;
}

function items(text: string, keys?: string[]): Str[] {
  return preProcess(text, keys).children.map((p) => p.children[0]);
}

function values(text: string, keys?: string[]): string[] {
  return items(text, keys).map((s) => s.value);
}

test("availableExtensions は .yaml / .yml", () => {
  assert.deepEqual(new Processor().availableExtensions(), [".yaml", ".yml"]);
});

test("キー未指定なら何も抽出しない", () => {
  assert.deepEqual(values("description: hello\n"), []);
  assert.deepEqual(values("description: hello\n", []), []);
});

test("ドット無しキーは任意の深さに再帰マッチする", () => {
  const text = "description: top\nnested:\n  description: deep\n";
  assert.deepEqual(values(text, ["description"]), ["top", "deep"]);
});

test("ドット付きパスは完全一致のみ", () => {
  const text = "a:\n  b: x\n  c: y\nb: z\n";
  assert.deepEqual(values(text, ["a.b"]), ["x"]);
});

test("* は任意のキー 1 段にマッチする", () => {
  const text = "foo:\n  description: a\nbar:\n  description: b\n";
  assert.deepEqual(values(text, ["*.description"]), ["a", "b"]);
});

test("[].key は配列要素内のキーにマッチする", () => {
  const text = "list:\n  - name: a\n  - name: b\n";
  assert.deepEqual(values(text, ["list[].name"]), ["a", "b"]);
});

test("マッチしないキーは空", () => {
  assert.deepEqual(values("title: hello\n", ["description"]), []);
});

test("plain scalar は range が value と一致する(fix 安全の不変条件)", () => {
  const text = "description: hello world\n";
  const it = items(text, ["description"])[0];
  assert.deepEqual(it.value, "hello world");
  assert.deepEqual(text.slice(it.range[0], it.range[1]), it.value);
});

test("block scalar (|-) は生ソース(インデント込み)を抽出し range が value と一致する", () => {
  // fix の range 整合をソース座標で保つため、YAML デコード後の値ではなく
  // 生ソース本体 (インデント込み・末尾改行除外) を採取する。
  const text = "description: |-\n  line one\n  line two\n";
  const it = items(text, ["description"])[0];
  assert.deepEqual(it.value, "  line one\n  line two");
  assert.deepEqual(text.slice(it.range[0], it.range[1]), it.value);
});

test("quoted scalar は安全のため除外する", () => {
  assert.deepEqual(values('description: "hello"\n', ["description"]), []);
});

test("loc は 1 始まりの行と 0 始まりの列を持つ", () => {
  const text = "a: x\ndescription: hello\n";
  const loc = items(text, ["description"])[0].loc;
  assert.deepEqual(loc.start, { line: 2, column: 13 });
  assert.deepEqual(loc.end, { line: 2, column: 18 });
});

test("1 行目の値の loc も 0 始まりの列を持つ", () => {
  const loc = items("description: hello\n", ["description"])[0].loc;
  assert.deepEqual(loc.start, { line: 1, column: 13 });
  assert.deepEqual(loc.end, { line: 1, column: 18 });
});

test("block scalar の loc も 0 始まりの列を持つ", () => {
  const item = items("description: |-\n  line one\n  line two\n", ["description"])[0];
  assert.deepEqual(item.loc.start, { line: 2, column: 0 });
  assert.deepEqual(item.loc.end, { line: 3, column: 10 });
});

test("AST ルート Document の loc は列 0 から始まる", () => {
  const ast = preProcess("description: hi\n", ["description"]);
  assert.deepEqual(ast.loc.start, { line: 1, column: 0 });
});

test("AST ルートは Document、子は Paragraph > Str", () => {
  const ast = preProcess("description: hi\n", ["description"]);
  assert.deepEqual(ast.type, "Document");
  assert.deepEqual(ast.children[0].type, "Paragraph");
  assert.deepEqual(ast.children[0].children[0].type, "Str");
});
