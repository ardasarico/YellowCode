// Imported rather than read from the themes folder, so a standalone binary carries them; the id is the file name.
import defaultDark from "../../themes/default-dark.json"
import defaultLight from "../../themes/default-light.json"
import dusk from "../../themes/dusk.json"
import ember from "../../themes/ember.json"
import forest from "../../themes/forest.json"
import highContrast from "../../themes/high-contrast.json"
import mono from "../../themes/mono.json"
import neon from "../../themes/neon.json"
import ocean from "../../themes/ocean.json"
import petal from "../../themes/petal.json"

export const BUILT_IN_THEMES: { id: string; json: unknown }[] = [
  { id: "default-dark", json: defaultDark },
  { id: "default-light", json: defaultLight },
  { id: "dusk", json: dusk },
  { id: "ember", json: ember },
  { id: "forest", json: forest },
  { id: "high-contrast", json: highContrast },
  { id: "mono", json: mono },
  { id: "neon", json: neon },
  { id: "ocean", json: ocean },
  { id: "petal", json: petal },
]
