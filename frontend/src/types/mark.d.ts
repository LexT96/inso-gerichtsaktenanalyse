declare module 'mark.js' {
  interface MarkOptions {
    className?: string;
    element?: string;
    separateWordSearch?: boolean;
    done?: (numberOfMatches: number) => void;
  }

  class Mark {
    constructor(context: HTMLElement | string);
    mark(keyword: string | string[], options?: MarkOptions): void;
    markRegExp(regex: RegExp, options?: MarkOptions): void;
    unmark(options?: MarkOptions): void;
  }

  export default Mark;
}
