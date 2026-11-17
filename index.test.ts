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
  const p = new Processor(keys ? { keys, markdown: false } : { markdown: false });
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

// ---- markdown: true ----

interface MdNode {
  type: string;
  value?: string;
  raw: string;
  range: [number, number];
  children?: MdNode[];
}

function mdAst(text: string, keys: string[] = ["description"]): MdNode {
  const p = new Processor({ keys, markdown: true });
  return p.processor(".yaml").preProcess(text) as unknown as MdNode;
}

function collectNodes(node: MdNode, type: string): MdNode[] {
  return [
    ...(node.type === type ? [node] : []),
    ...(node.children ?? []).flatMap((c) => collectNodes(c, type)),
  ];
}

function slice(text: string, n: MdNode): string {
  return text.slice(n.range[0], n.range[1]);
}

function assertStrInvariants(text: string, ast: MdNode): void {
  for (const s of collectNodes(ast, "Str")) {
    const value = s.value ?? "";
    assert.equal(slice(text, s), value);
    assert.equal(s.raw, value);
    // 行頭 (その行の先頭から Str までがインデントと引用の ">" だけ) の Str は、
    // 先頭に空白も ">" も持たない。inline code 直後の空白は Str に残る。
    // range[0] === 0 では lastIndexOf に負数を渡さないよう、行頭として明示的に扱う。
    const lineHeadStart = s.range[0] === 0 ? 0 : text.lastIndexOf("\n", s.range[0] - 1) + 1;
    const head = text.slice(lineHeadStart, s.range[0]);
    if (/^[ \t>]*$/.test(head)) {
      assert.match(value, /^[^ \t>]/);
    }
    assert.ok(!value.includes("\r"));
    assert.ok(value.length > 0);
  }
}

test("markdown 未指定は markdown: true と同じ AST", () => {
  const text = "description: |-\n  a `b`\n  c\n";
  const base = new Processor({ keys: ["description"] }).processor(".yaml").preProcess(text);
  const on = new Processor({ keys: ["description"], markdown: true })
    .processor(".yaml")
    .preProcess(text);
  assert.deepEqual(base, on);
  assert.equal(collectNodes(base as unknown as MdNode, "Code").length, 1);
});

test("markdown: false は inline code を分けず、バッククォートを含む 1 つの Str になる", () => {
  const text = "description: 注文は `GET /orders/{id}` で取得する。\n";
  const ast = new Processor({ keys: ["description"], markdown: false })
    .processor(".yaml")
    .preProcess(text) as unknown as MdNode;
  const strs = collectNodes(ast, "Str");
  assert.equal(strs.length, 1);
  assert.equal(strs[0].value, "注文は `GET /orders/{id}` で取得する。");
  assert.equal(collectNodes(ast, "Code").length, 0);
});

test("markdown: インライン code は Str / Code / Str に分かれ、range が源文と一致する", () => {
  const text = "description: 注文は `GET /orders/{id}` で取得する。\n";
  const ast = mdAst(text);
  const para = ast.children![0];
  assert.equal(para.type, "Paragraph");
  const kids = para.children!.filter((c) => c.type !== "Break");
  assert.deepEqual(
    kids.map((k) => k.type),
    ["Str", "Code", "Str"],
  );
  assert.equal(slice(text, kids[0]), "注文は ");
  assert.equal(slice(text, kids[1]), "`GET /orders/{id}`");
  assert.equal(kids[1].value, "GET /orders/{id}");
  assert.equal(slice(text, kids[2]), " で取得する。");
  assertStrInvariants(text, ast);
});

test("markdown: block scalar 内の fenced code と blockquote", () => {
  const text =
    "description: |\n  本文。\n\n  ```http\n  GET /orders/{id}\n  ```\n\n  > GET /orders/{id}\n";
  const ast = mdAst(text);
  const cb = collectNodes(ast, "CodeBlock")[0];
  assert.equal(cb.value, "GET /orders/{id}");
  assert.equal(slice(text, cb), "```http\n  GET /orders/{id}\n  ```");
  const bq = collectNodes(ast, "BlockQuote")[0];
  const str = collectNodes(bq, "Str")[0];
  assert.equal(slice(text, str), "GET /orders/{id}");
  assert.equal(str.value, "GET /orders/{id}");
  assertStrInvariants(text, ast);
});

test("markdown: 複数行 paragraph は行ごとの Str と Break(value は改行のみ)になる", () => {
  const text = "description: |-\n  one\n  two\n  three\n";
  const para = mdAst(text).children![0];
  assert.deepEqual(
    para.children!.map((c) => [c.type, c.value]),
    [
      ["Str", "one"],
      ["Break", "\n"],
      ["Str", "two"],
      ["Break", "\n"],
      ["Str", "three"],
    ],
  );
  assertStrInvariants(text, mdAst(text));
});

test("markdown: plain scalar の offset と loc", () => {
  const text = "a: x\ndescription: hello `c`\n";
  const ast = mdAst(text);
  const strs = collectNodes(ast, "Str");
  assert.equal(strs[0].range[0], text.indexOf("hello"));
  assert.equal(slice(text, collectNodes(ast, "Code")[0]), "`c`");
  assert.equal(
    (strs[0] as unknown as { loc: Str["loc"] }).loc.start.column,
    "description: ".length,
  );
});

test("markdown: 1. foo は List になる", () => {
  const text = "description: |-\n  1. foo\n  2. bar\n";
  const ast = mdAst(text);
  assert.equal(collectNodes(ast, "List").length, 1);
  assert.deepEqual(
    collectNodes(ast, "Str").map((s) => s.value),
    ["foo", "bar"],
  );
  assertStrInvariants(text, ast);
});

test("markdown: |2 (indentation indicator) でも対応する", () => {
  const text = "- description: |2\n    a `b`\n     indented\n  other: x\n";
  const ast = mdAst(text);
  assert.equal(slice(text, collectNodes(ast, "Code")[0]), "`b`");
  assertStrInvariants(text, ast);
  assert.deepEqual(
    collectNodes(ast, "Str").map((s) => s.value),
    ["a ", "indented"],
  );
});

test("markdown: CRLF の block scalar", () => {
  const text = "description: |-\r\n  a `b`\r\n  c\r\n\r\n  d\r\n";
  const ast = mdAst(text);
  assert.equal(slice(text, collectNodes(ast, "Code")[0]), "`b`");
  assert.deepEqual(
    collectNodes(ast, "Str").map((s) => s.value),
    ["a ", "c", "d"],
  );
  assertStrInvariants(text, ast);
});

test("markdown: inline code 直後の Str は先頭の空白を残す", () => {
  const text = "description: 注文は `GET` で取得する。\n";
  const ast = mdAst(text);
  const strs = collectNodes(ast, "Str");
  assert.deepEqual(
    strs.map((s) => s.value),
    ["注文は ", " で取得する。"],
  );
  for (const s of strs) {
    assert.equal(slice(text, s), s.value);
  }
});

test("markdown: 複数行 blockquote の継続行で '> ' を Str に含めない", () => {
  const text = "description: |-\n  > a\n  > b\n  > c\n";
  const ast = mdAst(text);
  const strs = collectNodes(ast, "Str");
  assert.deepEqual(
    strs.map((s) => s.value),
    ["a", "b", "c"],
  );
  for (const s of strs) {
    assert.equal(slice(text, s), s.value);
  }
});

test("markdown: list 内の blockquote の継続行でも '> ' を Str に含めない", () => {
  const text = "description: |-\n  - a\n    > b\n    > c\n";
  const ast = mdAst(text);
  const strs = collectNodes(ast, "Str");
  assert.deepEqual(
    strs.map((s) => s.value),
    ["a", "b", "c"],
  );
  for (const s of strs) {
    assert.equal(slice(text, s), s.value);
  }
});

test("markdown: header コメントの数字を indentation indicator と誤認しない", () => {
  const text = "description: | # see 9\n  para\n\n      code\n";
  const ast = mdAst(text);
  const cb = collectNodes(ast, "CodeBlock");
  assert.equal(cb.length, 1);
  assert.equal(cb[0].value, "code");
});

test("markdown: Image は alt と url を保つ", () => {
  const text = "description: 図 ![代替](http://example.com/a.png) です\n";
  const img = collectNodes(mdAst(text), "Image")[0] as MdNode & { alt?: string; url?: string };
  assert.equal(img.alt, "代替");
  assert.equal(img.url, "http://example.com/a.png");
  assert.equal(slice(text, img), "![代替](http://example.com/a.png)");
});

const lineStartCases: Array<[string, string, string[]]> = [
  ["引用の継続行に複数の空白", "description: |-\n  > a\n  >   b\n", ["a", "b"]],
  ["入れ子の引用", "description: |-\n  >> a\n  >>  b\n", ["a", "b"]],
  ["引用内のリスト", "description: |-\n  > - a\n  >   b\n", ["a", "b"]],
  ["空白 2 つの hard break の次の字下げ行", "description: |-\n  a  \n     b\n", ["a", "b"]],
  ["backslash の hard break の次の字下げ行", "description: |-\n  a\\\n     b\n", ["a", "b"]],
];

for (const [name, text, expected] of lineStartCases) {
  test(`markdown: ${name}で行頭の空白と ">" を Str に含めない`, () => {
    const ast = mdAst(text);
    assert.deepEqual(
      collectNodes(ast, "Str").map((s) => s.value),
      expected,
    );
    assertStrInvariants(text, ast);
  });
}
