// Vite `?url` imports resolve to the emitted asset's URL.
declare module '*?url' {
  const src: string;
  export default src;
}
