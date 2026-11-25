import { parse as parseMarkdown } from "@textlint/markdown-to-ast";
import { Minimatch } from "minimatch";
import path from "node:path";
import { isMap, isScalar, isSeq, LineCounter, parseAllDocuments } from "yaml";
// 先頭の `./` は照合するパスに現れないので、取り除いてから渡す。
const compilePatterns = (patterns) => patterns.map((p) => new Minimatch(p.replace(/^(\.\/)+/, ""), { dot: true, nonegate: true, nocomment: true }));
// textlint の loc.column は 0 始まり。yaml の linePos().col は 1 始まりなので 1 引く (issue #9)。
const createLoc = (lineCounter, start, end) => {
    const s = lineCounter.linePos(start);
    const e = lineCounter.linePos(end);
    return {
        start: { line: s.line, column: s.col - 1 },
        end: { line: e.line, column: e.col - 1 },
    };
};
const createStr = (start, end, lineCounter, source) => {
    const raw = source.slice(start, end);
    return {
        type: "Str",
        value: raw,
        raw,
        range: [start, end],
        loc: createLoc(lineCounter, start, end),
    };
};
// offset が行頭 (その行の先頭から offset までが空白・タブ・">" だけ) かどうか。
const atLineStart = (source, offset) => {
    if (offset === 0) {
        return true;
    }
    const lineHead = source.slice(source.lastIndexOf("\n", offset - 1) + 1, offset);
    return /^[ \t>]*$/.test(lineHead);
};
// 源文の [start, end) を行ごとの Str に分割する。
// 各 Str の range は行頭の空白・タブと行末の "\r" を除いた区間で、空行は捨てる。
// - 行頭の空白: range に含めると、jtf-style 等の fix が行頭の空白を消して yaml を壊す。
// - markdown 有効時 (markdown = true) は、行頭で始まる区間だけ行頭の空白と引用の ">" を除く。
//   対象は Str 内の改行の直後で始まる行 (継続行) と、源文上で行頭から区間の開始までが
//   空白・タブ・">" だけの先頭区間 (hard break の次の行など)。
//   継続行の ">" は Str の range に含まれて返るため、除かないと fix が引用を壊す。
//   行の途中で始まる先頭区間 (inline code の直後など) は、前後の語との間の空白を
//   Str に残すためそのまま採る。
// - 行末の "\r": CRLF の行終端なので含めない。含めると行末への fix が \r と \n の間に入り、
//   行構造を壊す。空行判定でも空白として扱う。
const createLineStrs = (start, end, lineCounter, source, markdown) => {
    const strs = [];
    let lineStart = start;
    let first = true;
    for (const line of source.slice(start, end).split("\n")) {
        let lineEnd = line.length;
        while (lineEnd > 0 && line[lineEnd - 1] === "\r") {
            lineEnd--;
        }
        let lead = 0;
        if (!markdown) {
            while (lead < lineEnd && (line[lead] === " " || line[lead] === "\t")) {
                lead++;
            }
        }
        else if (!first || atLineStart(source, start)) {
            lead = /^(?:[ \t]*>)*[ \t]*/.exec(line.slice(0, lineEnd))[0].length;
        }
        first = false;
        if (lead < lineEnd) {
            strs.push(createStr(lineStart + lead, lineStart + lineEnd, lineCounter, source));
        }
        lineStart += line.length + 1;
    }
    return strs;
};
// 隣り合う子の間に隙間があれば Break で埋める。
// sentence-splitter は Paragraph.raw を Paragraph.range[0] から走査し、
// いずれの子の range にも覆われない offset で走査を打ち切る。
// そのため行間 (改行 + インデント) を Break で覆い、後続の行が検査から落ちないようにする。
const fillGaps = (children, lineCounter, source) => {
    const out = [];
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
const parseKeyPath = (pathStr) => {
    const recursive = !pathStr.includes(".");
    const segments = [];
    for (const raw of pathStr.split(".")) {
        let part = raw;
        let arrayItem = false;
        if (part.endsWith("[]")) {
            arrayItem = true;
            part = part.slice(0, -2);
        }
        if (part === "*") {
            segments.push({ type: "anyKey" });
        }
        else if (part.length > 0) {
            segments.push({ type: "key", name: part });
        }
        if (arrayItem) {
            segments.push({ type: "arrayItem" });
        }
    }
    return { segments, recursive, pathString: pathStr };
};
const matchesAt = (matcher, currentPath) => {
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
// block scalar の本体からインデントを除いたテキストと、源文への対応表を作る。
// インデント幅は、header に indentation indicator があれば親のインデント + その数字、
// 無ければ最初の空でない行の先頭空白数。行ごとに min(インデント幅, その行の先頭空白数) を除く。
// 行末の "\r" は行終端なので text に含めない。
const createBlockMarkdownSource = (srcToken, bodyStart, body) => {
    const lines = body.split("\n").map((l) => l.replace(/\r+$/, ""));
    // コメント (`| # see 9`) の数字を拾わないよう、header token だけから読む。
    const header = srcToken.props
        .filter((p) => p.type === "block-scalar-header")
        .map((p) => p.source)
        .join("");
    const indicator = /[1-9]/.exec(header.replace(/^[|>]/, ""));
    let indent;
    if (indicator) {
        indent = (srcToken.indent ?? 0) + Number(indicator[0]);
    }
    else {
        const first = lines.find((l) => l.trim().length > 0) ?? "";
        indent = first.length - first.trimStart().length;
    }
    const dStart = [];
    const oStart = [];
    const out = [];
    let d = 0;
    let o = bodyStart;
    const raws = body.split("\n");
    lines.forEach((line, i) => {
        let c = 0;
        while (c < indent && line[c] === " ") {
            c++;
        }
        const content = line.slice(c);
        dStart.push(d);
        oStart.push(o + c);
        out.push(content);
        d += content.length + 1;
        o += raws[i].length + 1;
    });
    const map = (x) => {
        for (let k = dStart.length - 1; k >= 0; k--) {
            if (x >= dStart[k]) {
                return oStart[k] + (x - dStart[k]);
            }
        }
        return bodyStart;
    };
    // 終端 offset は、行の境界で次の行の先頭へ飛ばないよう直前の文字から写す。
    const mapEnd = (x) => (x > 0 ? map(x - 1) + 1 : map(0));
    return { text: out.join("\n"), map, mapEnd };
};
// markdown-to-ast の node を、源文上の range / loc を持つ node へ変換する。
// Str は PR 共通の規則 (行ごと・先頭空白と行末 \r を除く) で分割する。
const convertMarkdownNode = (node, md, lineCounter, source) => {
    const start = md.map(node.range[0]);
    const end = md.mapEnd(node.range[1]);
    if (node.type === "Str") {
        return createLineStrs(start, end, lineCounter, source, true);
    }
    const converted = {
        type: node.type,
        raw: source.slice(start, end),
        range: [start, end],
        loc: createLoc(lineCounter, start, end),
    };
    if (node.children) {
        const kids = node.children.flatMap((c) => convertMarkdownNode(c, md, lineCounter, source));
        converted.children = fillGaps(kids, lineCounter, source);
    }
    // Str 以外は markdown-to-ast の属性 (depth / url / alt / lang 等) をそのまま引き継ぐ。
    // 位置系 (range / loc / raw / position) は源文基準で作り直すので除く。
    // value は Code / CodeBlock / Html のような末端 node のものだけ残す。
    for (const [key, val] of Object.entries(node)) {
        if (["type", "raw", "range", "loc", "position", "children"].includes(key)) {
            continue;
        }
        if (key === "value" && node.children) {
            continue;
        }
        converted[key] = val;
    }
    return [converted];
};
const walk = (node, currentPath, matchers, lineCounter, collected, source) => {
    if (!node) {
        return;
    }
    if (isMap(node)) {
        for (const pair of node.items) {
            const keyNode = pair.key;
            const keyName = keyNode && keyNode.value !== undefined
                ? String(keyNode.value)
                : keyNode && typeof keyNode.toString === "function"
                    ? keyNode.toString()
                    : "";
            const valueNode = pair.value;
            const newPath = [...currentPath, keyName];
            // 複数の matcher が同じパスに当たっても、値は 1 回だけ収集する。
            if (matchers.some((m) => matchesAt(m, newPath))) {
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
                    let strs = [];
                    let md = null;
                    const sourceSlice = source.slice(valueNode.range[0], valueNode.range[1]);
                    if (sourceSlice === valueNode.value) {
                        const offset = valueNode.range[0];
                        strs.push(createStr(offset, valueNode.range[1], lineCounter, source));
                        md = {
                            text: valueNode.value,
                            map: (d) => offset + d,
                            mapEnd: (d) => offset + d,
                        };
                    }
                    else {
                        const srcToken = valueNode.srcToken;
                        if (srcToken &&
                            srcToken.type === "block-scalar" &&
                            Array.isArray(srcToken.props) &&
                            srcToken.props.length > 0 &&
                            typeof srcToken.source === "string") {
                            const lastProp = srcToken.props[srcToken.props.length - 1];
                            const bodyStart = lastProp.offset + lastProp.source.length;
                            let body = srcToken.source;
                            while (body.endsWith("\n") || body.endsWith("\r")) {
                                body = body.slice(0, -1);
                            }
                            strs = createLineStrs(bodyStart, bodyStart + body.length, lineCounter, source, false);
                            md = createBlockMarkdownSource(srcToken, bodyStart, body);
                        }
                    }
                    if (strs.length > 0 && md) {
                        collected.push({ strs, md });
                    }
                }
            }
            if (valueNode) {
                walk(valueNode, newPath, matchers, lineCounter, collected, source);
            }
        }
    }
    else if (isSeq(node)) {
        for (const item of node.items) {
            walk(item, [...currentPath, "[]"], matchers, lineCounter, collected, source);
        }
    }
};
class YamlKeysProcessor {
    entries;
    constructor(options = {}) {
        const legacy = options;
        for (const name of ["keys", "markdown"]) {
            if (name in legacy) {
                throw new Error(`トップレベルの \`${name}\` オプションは廃止された。\`files: [{ ${name}: ... }]\` の形で指定すること。`);
            }
        }
        this.entries = (options.files ?? []).map((entry) => ({
            include: entry.include ? compilePatterns(entry.include) : undefined,
            exclude: compilePatterns(entry.exclude ?? []),
            matchers: (entry.keys ?? []).map(parseKeyPath),
            markdown: entry.markdown ?? true,
        }));
    }
    availableExtensions() {
        return [".yaml", ".yml"];
    }
    // 先頭から見て最初に当たった要素を返す。filePath が無いときは include を持たない要素だけが当たる。
    selectEntry(filePath) {
        const relative = filePath === undefined
            ? undefined
            : path.relative(process.cwd(), path.resolve(filePath)).split(path.sep).join("/");
        return this.entries.find((entry) => {
            if (entry.include) {
                if (relative === undefined || !entry.include.some((mm) => mm.match(relative))) {
                    return false;
                }
            }
            return relative === undefined || !entry.exclude.some((mm) => mm.match(relative));
        });
    }
    processor(_ext) {
        return {
            preProcess: (text, filePath) => {
                const entry = this.selectEntry(filePath);
                const matchers = entry?.matchers ?? [];
                const markdown = entry?.markdown ?? true;
                const lineCounter = new LineCounter();
                // `---` 区切りの複数ドキュメントを全て検査する。LineCounter と collected は共有する。
                const docs = parseAllDocuments(text, {
                    lineCounter,
                    keepSourceTokens: true,
                });
                const collected = [];
                for (const doc of docs) {
                    if (doc.contents) {
                        walk(doc.contents, [], matchers, lineCounter, collected, text);
                    }
                }
                // markdown: true では scalar の値を markdown として解釈し、得た node 群を
                // そのまま Document の子にする (scalar ごとの Paragraph で包まない)。
                const children = markdown
                    ? collected.flatMap(({ md }) => parseMarkdown(md.text).children.flatMap((c) => convertMarkdownNode(c, md, lineCounter, text)))
                    : collected.map(({ strs }) => {
                        const kids = fillGaps(strs, lineCounter, text);
                        const range = [kids[0].range[0], kids[kids.length - 1].range[1]];
                        return {
                            type: "Paragraph",
                            children: kids,
                            raw: text.slice(range[0], range[1]),
                            range,
                            loc: createLoc(lineCounter, range[0], range[1]),
                        };
                    });
                const document = {
                    type: "Document",
                    children,
                    raw: text,
                    range: [0, text.length],
                    loc: createLoc(lineCounter, 0, text.length),
                };
                return document;
            },
            postProcess: (messages, filePath) => ({
                messages,
                filePath: filePath ?? "<yaml>",
            }),
        };
    }
}
export default {
    Processor: YamlKeysProcessor,
};
