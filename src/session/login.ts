export const LOGIN_HINT =
  "YellowCode cannot sign in by itself. Run `claude` in a terminal, sign in with /login, then start YellowCode again."

// Only what claude prints decides it; credentials and config are never read. An invalid API key fails the same way
// but asks for no /login, and claude's own text says enough.
export function needsLogin(error: string | undefined, text: string): boolean {
  return error === "authentication_failed" && text.includes("/login")
}
