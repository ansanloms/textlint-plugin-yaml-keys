interface PluginOptions {
    keys?: string[];
}
declare class YamlKeysProcessor {
    private keys;
    constructor(options?: PluginOptions);
    availableExtensions(): string[];
    processor(_ext: string): {
        preProcess: (text: string, _filePath?: string) => {
            type: string;
            children: {
                type: string;
                children: {
                    type: string;
                    value: string;
                    raw: string;
                    range: [number, number];
                    loc: {
                        start: {
                            line: number;
                            column: number;
                        };
                        end: {
                            line: number;
                            column: number;
                        };
                    };
                }[];
                raw: string;
                range: [number, number];
                loc: {
                    start: {
                        line: number;
                        column: number;
                    };
                    end: {
                        line: number;
                        column: number;
                    };
                };
            }[];
            raw: string;
            range: number[];
            loc: {
                start: {
                    line: number;
                    column: number;
                };
                end: {
                    line: number;
                    column: number;
                };
            };
        };
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
