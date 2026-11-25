interface FileEntry {
    include?: string[];
    exclude?: string[];
    keys?: string[];
    markdown?: boolean;
}
interface PluginOptions {
    files?: FileEntry[];
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
    private entries;
    constructor(options?: PluginOptions);
    availableExtensions(): string[];
    private selectEntry;
    processor(_ext: string): {
        preProcess: (text: string, filePath?: string) => TxtNode;
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
