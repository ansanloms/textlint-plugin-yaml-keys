interface PluginOptions {
    keys?: string[];
}
interface Loc {
    start: {
        line: number;
        column: number;
    };
    end: {
        line: number;
        column: number;
    };
}
interface TxtNode {
    type: string;
    raw: string;
    range: [number, number];
    loc: Loc;
    value?: string;
    children?: TxtNode[];
}
declare class YamlKeysProcessor {
    private keys;
    constructor(options?: PluginOptions);
    availableExtensions(): string[];
    processor(_ext: string): {
        preProcess: (text: string, _filePath?: string) => TxtNode;
        postProcess: (messages: unknown[], filePath?: string) => {
            messages: unknown[];
            filePath: string;
        };
    };
}
declare const _default: {
    Processor: typeof YamlKeysProcessor;
};
export default _default;
