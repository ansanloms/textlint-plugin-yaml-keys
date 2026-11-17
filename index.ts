import { isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import type { Node, Pair } from "yaml";

type SegmentMatcher = { type: "key"; name: string } | { type: "anyKey" } | { type: "arrayItem" };

interface KeyMatcher {
  segments: SegmentMatcher[];
  recursive: boolean;
  pathString: string;
}

interface PluginOptions {
  keys?: string[];
}

interface Loc {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

interface TxtNode {
  type: string;
  raw: string;
  range: [number, number];
  loc: Loc;
  value?: string;
  children?: TxtNode[];
}

type CollectedStr = TxtNode & { value: string };

// 1 つの scalar から得た Str 群 (block scalar は行ごとに複数になる)。
type CollectedItem = CollectedStr[];

// textlint の loc.column は 0 始まり。yaml の linePos().col は 1 始まりなので 1 引く (issue #9)。
const createLoc = (lineCounter: LineCounter, start: number, end: number): Loc => {
  const s = lineCounter.linePos(start);
  const e = lineCounter.linePos(end);
  return {
    start: { line: s.line, column: s.col - 1 },
    end: { line: e.line, column: e.col - 1 },
  };
};

const createStr = (
  start: number,
  end: number,
  lineCounter: LineCounter,
  source: string,
): CollectedStr => {
  const raw = source.slice(start, end);
  return {
    type: "Str",
    value: raw,
    raw,
    range: [start, end],
    loc: createLoc(lineCounter, start, end),
  };
};

// 隣り合う子の間に隙間があれば Break で埋める。
// sentence-splitter は Paragraph.raw を Paragraph.range[0] から走査し、
// いずれの子の range にも覆われない offset で走査を打ち切る。
// そのため行間 (改行 + インデント) を Break で覆い、後続の行が検査から落ちないようにする。
const fillGaps = (children: TxtNode[], lineCounter: LineCounter, source: string): TxtNode[] => {
  const out: TxtNode[] = [];
  for (const child of children) {
    const prev = out[out.length - 1];
    if (prev && prev.range[1] < child.range[0]) {
      const raw = source.slice(prev.range[1], child.range[0]);
      out.push({
        type: "Break",
        // textlint-util-to-string は node.value を文字列化に使うため、value は改行だけにする。
        // インデント等を含めると sentence-length 等が文字数に数えてしまう。
        // 位置計算に使われる raw / range は源文のまま保つ。
        value: raw.replace(/[^\n]/g, ""),
        raw,
        range: [prev.range[1], child.range[0]],
        loc: createLoc(lineCounter, prev.range[1], child.range[0]),
      });
    }
    out.push(child);
  }
  return out;
};

interface BlockScalarToken {
  type: string;
  source: string;
  props: { offset: number; source: string }[];
}

const parseKeyPath = (pathStr: string): KeyMatcher => {
  const recursive = !pathStr.includes(".");
  const segments: SegmentMatcher[] = [];
  for (const raw of pathStr.split(".")) {
    let part = raw;
    let arrayItem = false;
    if (part.endsWith("[]")) {
      arrayItem = true;
      part = part.slice(0, -2);
    }
    if (part === "*") {
      segments.push({ type: "anyKey" });
    } else if (part.length > 0) {
      segments.push({ type: "key", name: part });
    }
    if (arrayItem) {
      segments.push({ type: "arrayItem" });
    }
  }
  return { segments, recursive, pathString: pathStr };
};

const matchesAt = (matcher: KeyMatcher, currentPath: string[]): boolean => {
  if (matcher.recursive) {
    if (matcher.segments.length !== 1) {
      return false;
    }
    const seg = matcher.segments[0];
    if (seg.type !== "key") {
      return false;
    }
    return currentPath.length > 0 && currentPath[currentPath.length - 1] === seg.name;
  }
  if (currentPath.length !== matcher.segments.length) {
    return false;
  }
  for (let i = 0; i < matcher.segments.length; i++) {
    const seg = matcher.segments[i];
    const cur = currentPath[i];
    if (seg.type === "anyKey") {
      if (cur === "[]") {
        return false;
      }
      continue;
    }
    if (seg.type === "arrayItem") {
      if (cur !== "[]") {
        return false;
      }
      continue;
    }
    if (seg.type === "key" && cur !== seg.name) {
      return false;
    }
  }
  return true;
};

const walk = (
  node: Node | null,
  currentPath: string[],
  matchers: KeyMatcher[],
  lineCounter: LineCounter,
  collected: CollectedItem[],
  source: string,
): void => {
  if (!node) {
    return;
  }
  if (isMap(node)) {
    for (const pair of node.items as Pair[]) {
      const keyNode = pair.key as { value?: unknown; toString?: () => string };
      const keyName =
        keyNode && keyNode.value !== undefined
          ? String(keyNode.value)
          : keyNode && typeof keyNode.toString === "function"
            ? keyNode.toString()
            : "";
      const valueNode = pair.value as Node | null;
      const newPath = [...currentPath, keyName];
      for (const m of matchers) {
        if (matchesAt(m, newPath)) {
          if (isScalar(valueNode) && typeof valueNode.value === "string" && valueNode.range) {
            // textlint の report index と fix の絶対 range は、Str.range[0] + 相対 index を
            // 源文全体に対して解決して得られる (node.value / raw は位置計算に使われない)。
            // ルールは getSource(node) = 源文.slice(range) を読むため、
            // 全ての Str で source.slice(range) === value が成り立つ必要がある。
            // 成り立たないと、置換が源文上の誤位置にマップされ yaml 構造を壊す。
            // - plain scalar: range と value が一致するのでそのまま採用。
            // - block scalar (|- など): srcToken から本体の offset と本体 source を取り、
            //   行ごとに Str へ分割する。各 Str の range は行頭のインデントを除いた区間とする。
            //   インデントを range に含めると、jtf-style 等の fix が行頭の空白を消して
            //   yaml を壊すため。末尾改行は block scalar の closing として構文上の意味を
            //   持つため value/range から除外し、fix の対象外にする。
            // - quoted scalar 等の不一致ケース: range が引用符を含み value と一致しないため除外。
            const strs: CollectedStr[] = [];
            const sourceSlice = source.slice(valueNode.range[0], valueNode.range[1]);
            if (sourceSlice === valueNode.value) {
              strs.push(createStr(valueNode.range[0], valueNode.range[1], lineCounter, source));
            } else {
              const srcToken = (valueNode as unknown as { srcToken?: BlockScalarToken }).srcToken;
              if (
                srcToken &&
                srcToken.type === "block-scalar" &&
                Array.isArray(srcToken.props) &&
                srcToken.props.length > 0 &&
                typeof srcToken.source === "string"
              ) {
                const lastProp = srcToken.props[srcToken.props.length - 1];
                const bodyStart = lastProp.offset + lastProp.source.length;
                let body = srcToken.source;
                while (body.endsWith("\n") || body.endsWith("\r")) {
                  body = body.slice(0, -1);
                }
                let lineStart = bodyStart;
                for (const line of body.split("\n")) {
                  // CRLF の "\r" は行終端なので Str に含めない。含めると行末への fix が
                  // \r と \n の間に入り、行構造を壊す。空行判定でも空白として扱う。
                  let end = line.length;
                  while (end > 0 && line[end - 1] === "\r") {
                    end--;
                  }
                  let lead = 0;
                  while (lead < end && (line[lead] === " " || line[lead] === "\t")) {
                    lead++;
                  }
                  if (lead < end) {
                    strs.push(createStr(lineStart + lead, lineStart + end, lineCounter, source));
                  }
                  lineStart += line.length + 1;
                }
              }
            }
            if (strs.length > 0) {
              collected.push(strs);
            }
          }
        }
      }
      if (valueNode) {
        walk(valueNode, newPath, matchers, lineCounter, collected, source);
      }
    }
  } else if (isSeq(node)) {
    for (const item of node.items as Node[]) {
      walk(item, [...currentPath, "[]"], matchers, lineCounter, collected, source);
    }
  }
};

class YamlKeysProcessor {
  private keys: string[];

  constructor(options: PluginOptions = {}) {
    this.keys = options.keys ?? [];
  }

  availableExtensions(): string[] {
    return [".yaml", ".yml"];
  }

  processor(_ext: string) {
    const matchers = this.keys.map(parseKeyPath);
    return {
      preProcess: (text: string, _filePath?: string) => {
        const lineCounter = new LineCounter();
        const doc = parseDocument(text, {
          lineCounter,
          keepSourceTokens: true,
        });
        const collected: CollectedItem[] = [];
        if (doc.contents) {
          walk(doc.contents as Node, [], matchers, lineCounter, collected, text);
        }
        const children: TxtNode[] = collected.map((strs) => {
          const kids = fillGaps(strs, lineCounter, text);
          const range: [number, number] = [kids[0].range[0], kids[kids.length - 1].range[1]];
          return {
            type: "Paragraph",
            children: kids,
            raw: text.slice(range[0], range[1]),
            range,
            loc: createLoc(lineCounter, range[0], range[1]),
          };
        });
        const document: TxtNode = {
          type: "Document",
          children,
          raw: text,
          range: [0, text.length],
          loc: createLoc(lineCounter, 0, text.length),
        };
        return document;
      },
      postProcess: (messages: unknown[], filePath?: string) => ({
        messages,
        filePath: filePath ?? "<yaml>",
      }),
    };
  }
}

export default {
  Processor: YamlKeysProcessor,
};
