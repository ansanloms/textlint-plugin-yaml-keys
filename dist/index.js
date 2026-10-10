import { isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
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
            for (const m of matchers) {
                if (matchesAt(m, newPath)) {
                    if (isScalar(valueNode) && typeof valueNode.value === "string" && valueNode.range) {
                        // textlint fix の絶対 range は Str.range[0] + 相対 index で計算される。
                        // AST に渡す value と source.slice(range) が一致していないと、
                        // 置換が源文上の誤位置にマップされ yaml 構造を壊す。
                        // - plain / 単純な quoted scalar: range と value が一致するのでそのまま採用。
                        // - block scalar (|- など): srcToken から本体の offset と本体 source を取り
                        //   range/value をそろえる。末尾改行は block scalar の closing として
                        //   構文上の意味を持つため value/range から除外し、fix の対象外にする。
                        // - escape を含む quoted scalar 等の不一致ケース: 安全のため除外。
                        let collectedValue = null;
                        let collectedRange = null;
                        const sourceSlice = source.slice(valueNode.range[0], valueNode.range[1]);
                        if (sourceSlice === valueNode.value) {
                            collectedValue = valueNode.value;
                            collectedRange = [valueNode.range[0], valueNode.range[1]];
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
                                while (body.endsWith("\n")) {
                                    body = body.slice(0, -1);
                                }
                                if (body.length > 0) {
                                    collectedValue = body;
                                    collectedRange = [bodyStart, bodyStart + body.length];
                                }
                            }
                        }
                        if (collectedValue !== null && collectedRange !== null) {
                            const start = lineCounter.linePos(collectedRange[0]);
                            const end = lineCounter.linePos(collectedRange[1]);
                            collected.push({
                                value: collectedValue,
                                range: collectedRange,
                                loc: {
                                    start: { line: start.line, column: start.col },
                                    end: { line: end.line, column: end.col },
                                },
                            });
                        }
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
    keys;
    constructor(options = {}) {
        this.keys = options.keys ?? [];
    }
    availableExtensions() {
        return [".yaml", ".yml"];
    }
    processor(_ext) {
        const matchers = this.keys.map(parseKeyPath);
        return {
            preProcess: (text, _filePath) => {
                const lineCounter = new LineCounter();
                const doc = parseDocument(text, {
                    lineCounter,
                    keepSourceTokens: true,
                });
                const collected = [];
                if (doc.contents) {
                    walk(doc.contents, [], matchers, lineCounter, collected, text);
                }
                const lastPos = lineCounter.linePos(text.length);
                return {
                    type: "Document",
                    children: collected.map((item) => ({
                        type: "Paragraph",
                        children: [
                            {
                                type: "Str",
                                value: item.value,
                                raw: item.value,
                                range: item.range,
                                loc: item.loc,
                            },
                        ],
                        raw: item.value,
                        range: item.range,
                        loc: item.loc,
                    })),
                    raw: text,
                    range: [0, text.length],
                    loc: {
                        start: { line: 1, column: 1 },
                        end: { line: lastPos.line, column: lastPos.col },
                    },
                };
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
