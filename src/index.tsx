import { render, useKeyboard, useRenderer } from "@opentui/solid"

const App = () => {
  const renderer = useRenderer()

  useKeyboard((key) => {
    if (key.name === "q") renderer.destroy()
  })

  return (
    <box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column">
      <text fg="#FFD60A">
        <b>YellowCode</b>
      </text>
      <text fg="#8A8A8A">press q to quit</text>
    </box>
  )
}

await render(App)
