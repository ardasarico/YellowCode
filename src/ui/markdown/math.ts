export type MathSpan = { text: string; math: boolean }

// `$…$` needs no space inside either `$` and no digit after the closing one, so prices stay text.
const SPANS = /\$\$([^$]+?)\$\$|\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g

export function mathSpans(text: string): MathSpan[] {
  const spans: MathSpan[] = []
  let from = 0
  for (const match of text.matchAll(SPANS)) {
    if (match.index > from) spans.push({ text: text.slice(from, match.index), math: false })
    spans.push({ text: toUnicode(match[1] ?? match[2] ?? ""), math: true })
    from = match.index + match[0].length
  }
  if (from < text.length) spans.push({ text: text.slice(from), math: false })
  return spans
}

const SYMBOLS: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  sum: "∑",
  prod: "∏",
  int: "∫",
  leq: "≤",
  le: "≤",
  geq: "≥",
  ge: "≥",
  neq: "≠",
  ne: "≠",
  approx: "≈",
  cdot: "·",
  times: "×",
  pm: "±",
  infty: "∞",
  to: "→",
  left: "",
  right: "",
}

const pairs = (from: string, to: string): Record<string, string> =>
  Object.fromEntries(from.split("").map((char, index) => [char, to[index] ?? char]))

const SUPERSCRIPT = pairs("0123456789+-=()abcdefghijklmnoprstuvwxyz", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ")
const SUBSCRIPT = pairs("0123456789+-=()aehijklmnoprstuvx", "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ")

function script(text: string, map: Record<string, string>): string | null {
  const chars = text.split("")
  return chars.every((char) => map[char]) ? chars.map((char) => map[char]).join("") : null
}

// A best-effort TeX to Unicode conversion; whatever it does not know stays as written.
export function toUnicode(tex: string): string {
  const whole = /^\\frac\{[^{}]*\}\{[^{}]*\}$/.test(tex.trim())
  let text = tex
    .trim()
    .replace(/\\([a-zA-Z]+)/g, (raw, name: string) => (Object.hasOwn(SYMBOLS, name) ? (SYMBOLS[name] ?? raw) : raw))
  text = text.replace(/([\^_])(?:\{([^{}]*)\}|([^\s{}\\]))/g, (raw, mark: string, group?: string, char?: string) => {
    return script(group ?? char ?? "", mark === "^" ? SUPERSCRIPT : SUBSCRIPT) ?? raw
  })
  let previous = ""
  while (previous !== text) {
    previous = text
    text = text
      .replace(/\\hat\{(.)\}/g, "$1̂")
      .replace(/\\sqrt\{([^{}]*)\}/g, (_, inner: string) => (inner.length === 1 ? `√${inner}` : `√(${inner})`))
      .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, (_, top: string, bottom: string) =>
        whole ? `${top}/${bottom}` : `(${top}/${bottom})`,
      )
  }
  return text.normalize("NFC")
}
