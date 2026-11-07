/** Narrow module typing for the existing locked js-yaml 4 parser. */
declare module 'js-yaml' {
  export function load(input: string): unknown
}
