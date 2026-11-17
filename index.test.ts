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
  loc: Str["loc"];
  children: Array<{ type: string; range: [number, number]; children: Str[] }>;
}

function preProcess(text: string, keys?: string[]): Ast {
  const p = new Processor(keys ? { keys } : {});
  return p.processor(".yaml").preProcess(text) as unknown as Ast;
}

function items(text: string, keys?: string[]): Str[] {
  return preProcess(text, keys).children.flatMap((p) => p.children.filter((c) => c.type === "Str"));
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

test("block scalar (|-) は行ごとの Str に分割し、インデントを含めない", () => {
  const text = "description: |-\n  line one\n  line two\n";
  const kids = preProcess(text, ["description"]).children[0].children;
  assert.deepEqual(
    kids.map((k) => [k.type, k.value]),
    [
      ["Str", "line one"],
      ["Break", "\n"],
      ["Str", "line two"],
    ],
  );
  for (const k of kids.filter((n) => n.type === "Str")) {
    assert.equal(text.slice(k.range[0], k.range[1]), k.value);
  }
});

test("Break の range は改行とインデントを覆う", () => {
  const text = "description: |-\n  line one\n  line two\n";
  const kids = preProcess(text, ["description"]).children[0].children;
  assert.deepEqual(kids[1].range, [kids[0].range[1], kids[2].range[0]]);
  assert.equal(text.slice(kids[1].range[0], kids[1].range[1]), "\n  ");
});

test("Break.value は改行のみで、raw はインデントを保つ", () => {
  const two = "description: |-\n  a\n  b\n";
  const b1 = preProcess(two, ["description"]).children[0].children[1] as Str & { raw: string };
  assert.equal(b1.value, "\n");
  assert.equal(b1.raw, "\n  ");
  const blank = "description: |\n  a\n\n  b\n";
  const b2 = preProcess(blank, ["description"]).children[0].children[1] as Str & { raw: string };
  assert.equal(b2.value, "\n\n");
  assert.equal(b2.raw, "\n\n  ");
});

test("CRLF: 行末の \\r と空行を Str に含めない", () => {
  const text = "description: |-\r\n  a\r\n\r\n  b\r\n";
  const strs = items(text, ["description"]);
  assert.deepEqual(
    strs.map((k) => k.value),
    ["a", "b"],
  );
  for (const k of strs) {
    assert.equal(text.slice(k.range[0], k.range[1]), k.value);
    assert.ok(!k.value.includes("\r"));
  }
  const breaks = preProcess(text, ["description"]).children[0].children as unknown as Array<
    Str & { raw: string }
  >;
  const brk = breaks.filter((k) => k.type === "Break");
  assert.equal(brk.length, 1);
  assert.equal(brk[0].value, "\n\n");
  assert.ok(!brk[0].value.includes("\r"));
  assert.equal(brk[0].raw, text.slice(brk[0].range[0], brk[0].range[1]));
  assert.ok(brk[0].raw.startsWith("\r\n"));
});

test("Paragraph の range は最初の子の開始から最後の子の終端まで", () => {
  const text = "description: |-\n  line one\n  line two\n";
  const p = preProcess(text, ["description"]).children[0];
  assert.deepEqual(p.range, [p.children[0].range[0], p.children[2].range[1]]);
});

const blockCases: Array<[string, string, string[]]> = [
  ["空行を含む", "description: |\n  a\n\n  b\n", ["a", "b"]],
  ["|+", "description: |+\n  a\n  b\n\n", ["a", "b"]],
  ["> (folded)", "description: >\n  a\n  b\n", ["a", "b"]],
  ["|2 (indentation indicator)", "- description: |2\n    a\n    b\n  other: x\n", ["a", "b"]],
  ["深いインデントの行", "description: |\n  a\n    b\n", ["a", "b"]],
];

for (const [name, text, expected] of blockCases) {
  test(`block scalar ${name}: 全 Str で range が value と一致し先頭空白を含まない`, () => {
    const kids = preProcess(text, ["description"]).children[0].children;
    const strs = kids.filter((k) => k.type === "Str");
    assert.deepEqual(
      strs.map((k) => k.value),
      expected,
    );
    for (const k of strs) {
      assert.equal(text.slice(k.range[0], k.range[1]), k.value);
      assert.equal(k.value, k.value.trimStart());
    }
  });
}

test("YAML のパースエラーがあっても preProcess は例外を投げない", () => {
  const text = "description: hello\nfoo: [unclosed\n  bar: |-\n   x\n: :\n";
  assert.doesNotThrow(() => preProcess(text, ["description"]));
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
  const strs = items("description: |-\n  line one\n  line two\n", ["description"]);
  assert.deepEqual(strs[0].loc.start, { line: 2, column: 2 });
  assert.deepEqual(strs[0].loc.end, { line: 2, column: 10 });
  assert.deepEqual(strs[1].loc.start, { line: 3, column: 2 });
  assert.deepEqual(strs[1].loc.end, { line: 3, column: 10 });
});

test("AST ルート Document の loc は列 0 から始まる", () => {
  const ast = preProcess("description: hi\n", ["description"]);
  assert.deepEqual(ast.loc.start, { line: 1, column: 0 });
});

test("loc.column は 0 始まり", () => {
  const ast = preProcess("description: hello\n", ["description"]);
  assert.equal(items("description: hello\n", ["description"])[0].loc.start.column, 13);
  assert.equal(ast.loc.start.line, 1);
  assert.equal(ast.loc.start.column, 0);
});

test("AST ルートは Document、子は Paragraph > Str", () => {
  const ast = preProcess("description: hi\n", ["description"]);
  assert.deepEqual(ast.type, "Document");
  assert.deepEqual(ast.children[0].type, "Paragraph");
  assert.deepEqual(ast.children[0].children[0].type, "Str");
});
