// Tests assert on loosely shaped JSON bodies.
declare global {
  interface Response {
    json(): Promise<any>;
  }
}
export {};
