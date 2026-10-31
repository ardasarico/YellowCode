// The parts of Babel the standalone binary's mod loader uses; the packages ship no types.
declare module "@babel/core" {
  export function transformAsync(code: string, options: object): Promise<{ code?: string | null } | null>
}
declare module "@babel/preset-typescript" {
  const preset: object
  export default preset
}
declare module "babel-preset-solid" {
  const preset: object
  export default preset
}
declare module "babel-plugin-module-resolver" {
  const plugin: object
  export default plugin
}
