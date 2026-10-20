export type Rgb = [number, number, number]

function fromHsl(hue: number, saturation: number, lightness: number): Rgb {
  const s = saturation / 100
  const l = lightness / 100
  const at = (n: number) => {
    const k = (n + hue / 30) % 12
    return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return [at(0), at(8), at(4)]
}

// Only explicit colour codes; colour names would match ordinary words.
export function swatchColor(code: string): Rgb | null {
  const text = code.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text)?.[1]
  if (hex) {
    const full = hex.length === 3 ? hex.replace(/./g, "$&$&") : hex
    const channel = (at: number) => parseInt(full.slice(at, at + 2), 16)
    return [channel(0), channel(2), channel(4)]
  }
  const rgb = /^rgb\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*\)$/i.exec(text)
  if (rgb) {
    const [red = 0, green = 0, blue = 0] = rgb.slice(1).map(Number)
    return Math.max(red, green, blue) <= 255 ? [red, green, blue] : null
  }
  const number = String.raw`(\d+(?:\.\d+)?)`
  const hsl = new RegExp(String.raw`^hsl\(\s*${number}(?:deg)?\s*,?\s*${number}%\s*,?\s*${number}%\s*\)$`, "i").exec(
    text,
  )
  if (hsl) {
    const [hue = 0, saturation = 0, lightness = 0] = hsl.slice(1).map(Number)
    return saturation <= 100 && lightness <= 100 ? fromHsl(hue % 360, saturation, lightness) : null
  }
  return null
}

function luminance(color: Rgb) {
  const [red = 0, green = 0, blue = 0] = color.map((channel) => {
    const c = channel / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

// A dark colour on a dark background can still be told apart, so this looks at contrast rather than channel gaps.
export function blendsIn(color: Rgb, behind: Rgb) {
  const [a, b] = [luminance(color), luminance(behind)]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) < 1.2
}
