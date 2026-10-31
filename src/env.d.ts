// solid-js types JSX.Element with the DOM `Node`, but this app has no DOM lib.
interface Node {}

// Imported `with { type: "file" }`: the path of the file, embedded in a standalone binary.
declare module "*.png" {
  const path: string
  export default path
}
